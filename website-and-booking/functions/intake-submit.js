// Cloudflare Pages Function — POST /intake-submit
//
// Receives the multi-step intake form (intake.html) as JSON, upserts the client
// and writes one intake_forms row into the Supabase Postgres database, then sends
// the "before your session" guide email via Resend.
//
// Storage was migrated from Cloudflare D1 to Supabase (Postgres) in Aug 2026.
// Writes go through Supabase's REST API (PostgREST) with the service-role key,
// which bypasses Row Level Security — so the tables stay locked to the public
// anon key while this server-side Function retains full write access. No SDK is
// used, matching the dependency-free style of the other Functions.
//
// There is intentionally NO GET handler — this data is never publicly readable.
// Only this POST writes it; viewing happens via the Supabase dashboard or a
// future protected admin page.
//
// Env (set in the Cloudflare Pages dashboard):
//   SUPABASE_URL               — e.g. https://thxunrygrrxcdjhgshjw.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  — service-role key (bypasses RLS; keep secret)
//   RESEND_API_KEY             — Resend API key for sending email

import {
  INK, BODY_TEXT, FONT, FONT_HEADING,
  sendEmail, esc, emailButton, emailHeader, emailFooter, emailShell,
} from './_email.js';
import { sbRequest } from './_supabase.js';
import { pushIntakeCompleted } from './_push.js';
import { INTAKE_RULES as R } from './_intake-rules.js';
import { logIntakeError } from './_intake-log.js';

const FROM = 'haloe <halima@haloe.health>';
const HALIMA_EMAIL = 'halima@haloe.health';
const GUIDE_URL = 'https://haloe.health/before-your-session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SIGNATURE_BUCKET = 'signatures';
const SIGNATURE_MAX_B64 = 700000; // ~500KB of PNG; a real signature is ~10-40KB

export async function onRequestPost(context) {
  try {
    // --- Parse JSON body ---
    let data;
    try {
      data = await context.request.json();
    } catch (err) {
      return json({ error: 'Invalid request.' }, 400);
    }
    if (!data || typeof data !== 'object') {
      return json({ error: 'Invalid request.' }, 400);
    }

    // --- Honeypot: a filled "website" field means a bot. Ack silently (200) so
    //     bots can't tell their submission was dropped. Never written to the DB. ---
    if (typeof data.website === 'string' && data.website.trim() !== '') {
      return json({ ok: true }, 200);
    }

    // --- Which form is this? A page from before the form types existed sends no form_type: that is the original hijama form,
    //     checked exactly as before (so an old copy cached on someone's phone still works). New pages are checked per type. ---
    const ua = context.request.headers.get('user-agent') || '';
    const strict = typeof data.form_type === 'string' && data.form_type.trim() !== '';
    const formType = strict ? str(data.form_type) : 'hijama';
    const T = R.TYPES[formType];
    // Every refusal says what is wrong AND is recorded (type + reason only, never answers), so "it didn't go through" leaves a trace.
    const fail = (status, msg) => {
      try { context.waitUntil(logIntakeError(context.env, { stage: 'server', status, message: msg, form_type: formType, user_agent: ua })); } catch (e) { /* ignore */ }
      return json({ error: msg }, status);
    };
    if (!T) return fail(400, 'That form isn\u2019t recognised. Please reload the page and try again.');

    // --- Validation: name, email, the consents this form needs, and (new forms) phone, date of birth, signature ---
    const fullName = str(data.full_name);
    const email = str(data.email).toLowerCase();
    if (!fullName) return fail(400, 'Please enter your full name.');
    if (!(strict ? R.validEmail(email) : EMAIL_RE.test(email))) return fail(400, 'Please enter a valid email address.');

    const consents = strict ? T.consents : [
      'consent_accurate_info',
      'consent_complementary',
      'consent_treatment',
      'consent_notify_changes',
      'consent_data_storage',
      'consent_modesty', // Modesty and care (care-copy.js): required on every NEW submission. Old rows keep null and are never backfilled.
    ];
    for (const c of consents) {
      if (!truthy(data[c])) return fail(400, 'Please tick all required consent boxes.');
    }
    if (strict) {
      const ph = str(data.phone);
      if ((formType !== 'checkin' || ph) && !R.validUkPhone(ph)) return fail(400, 'Please enter a UK phone number, like 07700 900123 or +44 7700 900123.');
      if (T.physical) {
        const dob = R.checkDob(str(data.date_of_birth));
        if (!dob.ok) return fail(400, R.DOB_MSG[dob.reason]);
        if (!truthy(data.age_confirmed)) return fail(400, 'Please confirm you are 18 or over.');
        const ep = str(data.emergency_contact_phone);
        if (ep && !R.validPhoneAny(ep)) return fail(400, 'Please enter a valid phone number for your emergency contact.');
      }
      if (T.signature && !decodeSignaturePng(data.signature_png)) return fail(400, 'Please sign in the box before sending.');
    }

    const supabaseUrl = str(context.env.SUPABASE_URL).replace(/\/$/, '');
    const serviceKey = context.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      console.error('intake-submit: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
      return json({ error: 'Server is not configured. Please message me on Instagram.' }, 500);
    }

    // --- Upsert client by email, in one call ---
    // PostgREST upsert: on_conflict=email + Prefer: resolution=merge-duplicates
    // inserts a new client or updates the existing one (matched on the unique
    // email column), and returns the row so we can read its id back.
    const phone = str(data.phone);
    const dob = str(data.date_of_birth);

    const clientRows = await sbRequest(context.env, {
      path: '/rest/v1/clients?on_conflict=email',
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      // Only what was given: a check-in or home-visit form has no date of birth, and must not wipe the one already on file.
      body: [Object.assign({ full_name: fullName, email }, phone ? { phone } : {}, dob ? { date_of_birth: dob } : {})],
    });
    const clientId = Array.isArray(clientRows) && clientRows[0] && clientRows[0].id;
    if (!clientId) {
      throw new Error('Supabase upsert returned no client id');
    }

    // --- Insert the intake form row (every answer mapped to its column) ---
    // Text answers via orNull (blank -> null); the acks/consents as booleans.
    const intakeRow = {
      client_id: clientId,
      area_postcode: orNull(data.area_postcode),
      package: orNull(data.package),
      emergency_contact_name: orNull(data.emergency_contact_name),
      emergency_contact_phone: orNull(data.emergency_contact_phone),
      gp_name: orNull(data.gp_name),
      age_confirmed: orNull(data.age_confirmed),
      has_conditions: orNull(data.has_conditions),
      medical_conditions: orNull(data.medical_conditions),
      takes_medication: orNull(data.takes_medication),
      current_medications: orNull(data.current_medications),
      has_allergies: orNull(data.has_allergies),
      allergies: orNull(data.allergies),
      had_hijama_before: orNull(data.had_hijama_before),
      main_concern: orNull(data.main_concern),
      is_pregnant: orNull(data.is_pregnant),
      breastfeeding: orNull(data.breastfeeding),
      takes_blood_thinners: orNull(data.takes_blood_thinners),
      bleeding_disorder: orNull(data.bleeding_disorder),
      diabetes_status: orNull(data.diabetes_status),
      chemo_or_radiotherapy: orNull(data.chemo_or_radiotherapy),
      has_anaemia: orNull(data.has_anaemia),
      infectious_condition: orNull(data.infectious_condition),
      recent_surgery: orNull(data.recent_surgery),
      blood_pressure: orNull(data.blood_pressure),
      skin_condition: orNull(data.skin_condition),
      pacemaker_epilepsy: orNull(data.pacemaker_epilepsy),
      safety_notes: orNull(data.safety_notes),
      before_after_ack: truthy(data.before_after_ack),
      consent_accurate_info: truthy(data.consent_accurate_info),
      consent_complementary: truthy(data.consent_complementary),
      consent_treatment: truthy(data.consent_treatment),
      consent_notify_changes: truthy(data.consent_notify_changes),
      consent_data_storage: truthy(data.consent_data_storage),
      consent_modesty: !!(T.physical || !strict),
      consent_modesty_at: (T.physical || !strict) ? new Date().toISOString() : null,   // set here on the server, never taken from the browser
      photo_consent: orNull(data.photo_consent),
      signature_name: orNull(data.signature_name),
      signature_date: orNull(data.signature_date),
    };
    // Form type, the extra answers and the higher-risk flags (supabase-intake-types.sql). If those columns aren't there yet the
    // form is still saved with everything that matters in the classic columns, and the type is noted in them.
    const answers = cleanAnswers(data.answers);
    const riskFlags = R.riskFlags(intakeRow, answers);
    const extra = { form_type: formType, answers: Object.keys(answers).length ? answers : null, risk_flags: riskFlags.length ? riskFlags : null };
    let intakeRows;
    try {
      intakeRows = await sbRequest(context.env, {
        path: '/rest/v1/intake_forms',
        method: 'POST',
        prefer: 'return=representation',
        body: [Object.assign({}, intakeRow, extra)],
      });
    } catch (err) {
      if (!/form_type|answers|risk_flags/.test(String(err && err.message))) throw err;
      console.error('intake-submit: form_type/answers/risk_flags columns missing — run supabase-intake-types.sql. Saving without them.');
      const fallback = Object.assign({}, intakeRow);
      if (formType !== 'hijama' && !fallback.package) fallback.package = 'Form: ' + T.label;
      const note = answersToNote(answers);
      if (note) fallback.safety_notes = [fallback.safety_notes, note].filter(Boolean).join(' | ');
      intakeRows = await sbRequest(context.env, {
        path: '/rest/v1/intake_forms',
        method: 'POST',
        prefer: 'return=representation',
        body: [fallback],
      });
    }
    const intakeId = Array.isArray(intakeRows) && intakeRows[0] && intakeRows[0].id;

    // --- Drawn signature -> private Storage bucket (best effort) ---
    // The intake row above is the legal record and is already saved, so a
    // storage problem (or the signature_path migration not being applied yet)
    // must never lose it. The typed name and date are stored regardless.
    let signatureSaved = null;
    const sigBytes = decodeSignaturePng(data.signature_png);
    if (sigBytes && intakeId) {
      try {
        const objectPath = `${intakeId}.png`;
        const up = await fetch(`${supabaseUrl}/storage/v1/object/${SIGNATURE_BUCKET}/${objectPath}`, {
          method: 'POST',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'image/png',
            'x-upsert': 'true',
          },
          body: sigBytes,
        });
        if (!up.ok) throw new Error(`storage upload responded ${up.status}: ${await up.text()}`);
        await sbRequest(context.env, {
          path: `/rest/v1/intake_forms?id=eq.${intakeId}`,
          method: 'PATCH',
          prefer: 'return=minimal',
          body: { signature_path: `${SIGNATURE_BUCKET}/${objectPath}` },
        });
        signatureSaved = true;
      } catch (err) {
        signatureSaved = false;
        console.error(`intake-submit: signature for intake ${intakeId} NOT saved (record was saved):`, err);
      }
    }

    // --- Lock-screen alert to the admin's devices (best effort). The form and signature are already saved, so a push
    //     problem can never fail the submission or lose the client's data. The push says only that an intake arrived
    //     (and "needs a look" if an Act-on-this rule fires) — never a name or any health detail. ---
    try {
      await pushIntakeCompleted(context.env, { clientId, intake: intakeRow, clientPhone: phone, riskFlags });
    } catch (err) {
      console.error('intake-submit: push alert failed (record was saved):', err);
    }

    // --- The record is saved; the emails are best-effort from here on. ---
    // Halima hears about every completed form by email as well as push (so it still reaches her if alerts are off on her phone).
    // No name and no health detail in it — just the form type, whether anything is flagged, and a link to the client's brief.
    try {
      const apiKey = context.env.RESEND_API_KEY;
      if (apiKey) {
        await sendEmail(apiKey, {
          from: FROM,
          to: [HALIMA_EMAIL],
          subject: riskFlags.length ? 'haloe · intake form completed · needs a look' : 'haloe · intake form completed',
          html: halimaAlertHtml(T.label, riskFlags.length > 0, clientId),
        });
      }
    } catch (err) {
      console.error('intake-submit: alert email to Halima failed (record was saved):', err);
    }

    // The client's own thank-you with the pre-session guide is for the cupping forms (the guide is about cupping aftercare).
    try {
      const apiKey = context.env.RESEND_API_KEY;
      if (!apiKey) {
        console.error('intake-submit: RESEND_API_KEY not configured; skipping guide email');
      } else if (formType === 'hijama' || formType === 'dry') {
        await sendEmail(apiKey, {
          from: FROM,
          to: [email],
          reply_to: HALIMA_EMAIL,
          subject: 'Your haloe session — how to prepare',
          html: guideEmailHtml(fullName),
        });
      }
    } catch (err) {
      console.error('intake-submit: failed to send guide email (record was saved):', err);
    }

    return json({ ok: true, signature_saved: signatureSaved, form_type: formType }, 200);
  } catch (err) {
    console.error('intake-submit: unexpected error:', err);
    try { context.waitUntil(logIntakeError(context.env, { stage: 'server', status: 500, message: String(err && err.message || err), form_type: '', user_agent: context.request.headers.get('user-agent') || '' })); } catch (e) { /* ignore */ }
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}

// POST only. (A browser opening this address used to be handed the website; now it is told plainly.)
export function onRequestGet() {
  return json({ error: 'Not allowed.' }, 405);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Trim a value to a string ('' for null/undefined/non-string-ish).
function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

// Trimmed string, or null when empty — keeps optional blanks out of the DB.
function orNull(v) {
  const s = str(v);
  return s === '' ? null : s;
}

// A PNG data URL from the signature pad -> bytes, or null if it isn't a
// sane, size-capped PNG. Never throws: a bad signature just isn't stored.
function decodeSignaturePng(v) {
  const prefix = 'data:image/png;base64,';
  if (typeof v !== 'string' || !v.startsWith(prefix)) return null;
  const b64 = v.slice(prefix.length);
  if (!b64 || b64.length > SIGNATURE_MAX_B64) return null;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const magic = [0x89, 0x50, 0x4e, 0x47];
    return magic.every((b, i) => bytes[i] === b) ? bytes : null;
  } catch (e) {
    return null;
  }
}

// The extra, per-form answers: a small plain object of short strings, nothing else.
function cleanAnswers(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  let n = 0;
  for (const k of Object.keys(v)) {
    if (n >= 30) break;
    if (!/^[a-z_]{1,40}$/.test(k)) continue;
    const val = v[k];
    if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') continue;
    const t = String(val).trim().slice(0, 2000);
    if (t === '') continue;
    out[k] = t; n++;
  }
  return out;
}
function answersToNote(a) {
  return Object.keys(a).map((k) => k.replace(/_/g, ' ') + ': ' + a[k]).join('; ').slice(0, 1500);
}

// Accept 1 / '1' / true / 'Yes' as truthy (consent checkboxes + acks).
function truthy(v) {
  return v === 1 || v === true || v === '1' || v === 'Yes' || v === 'yes';
}

/* ------------------------------------------------------------------ */
/* Email template — pre-session guide                                 */
/* ------------------------------------------------------------------ */

// To Halima only. Deliberately says nothing about who or what: a form arrived, of which kind, and whether anything needs a look.
function halimaAlertHtml(typeLabel, flagged, clientId) {
  const link = clientId ? 'https://haloe.health/app/#/brief/c/' + Number(clientId) : 'https://haloe.health/app/#/clients';
  const inner = `${emailHeader()}
              <tr>
                <td style="padding:30px 4px 4px;">
                  <h1 style="color:${INK};font-size:22px;font-weight:normal;margin:0 0 16px;font-family:${FONT_HEADING};">A form has been completed</h1>
                  <p style="color:${BODY_TEXT};font-size:15px;line-height:1.75;margin:0 0 12px;font-family:${FONT};">Form: ${esc(typeLabel)}.</p>
                  <p style="color:${BODY_TEXT};font-size:15px;line-height:1.75;margin:0 0 22px;font-family:${FONT};">${flagged ? 'One or more answers need a look before the session.' : 'Nothing is flagged.'}</p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding:0 4px 26px;">
                  ${emailButton(link, 'Open in the app')}
                </td>
              </tr>
              ${emailFooter()}`;
  return emailShell(inner);
}

// COMPLIANCE: wellness/symptom language only — no claims to treat/cure conditions.
function guideEmailHtml(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  const greeting = first ? `Dear ${esc(first)},` : 'Hello,';

  const inner = `${emailHeader()}
              <!-- Intro -->
              <tr>
                <td style="padding:30px 4px 4px;">
                  <h1 style="color:${INK};font-size:24px;font-weight:normal;margin:0 0 18px;font-family:${FONT_HEADING};">Your form is in — thank you</h1>
                  <p style="color:${INK};font-size:15px;line-height:1.75;margin:0 0 16px;font-family:${FONT};">${greeting}</p>
                  <p style="color:${BODY_TEXT};font-size:15px;line-height:1.75;margin:0 0 16px;font-family:${FONT};">Thank you for completing your intake form — that's everything I need, and you're all set for your session.</p>
                  <p style="color:${BODY_TEXT};font-size:15px;line-height:1.75;margin:0 0 22px;font-family:${FONT};">Before you come, please take a couple of minutes to read your short pre-session guide. It walks you through exactly what to expect on the day and how to prepare so you feel completely at ease.</p>
                </td>
              </tr>
              <!-- Guide button -->
              <tr>
                <td align="center" style="padding:0 4px 26px;">
                  ${emailButton(GUIDE_URL, 'Read your pre-session guide')}
                </td>
              </tr>
              <!-- Sign-off + compliance -->
              <tr>
                <td style="padding:4px 4px 0;">
                  <p style="color:${INK};font-size:15px;line-height:1.75;margin:0 0 16px;font-family:${FONT};">I look forward to seeing you. — Halima &middot; @haloe.health</p>
                  <p style="color:${BODY_TEXT};font-size:12px;line-height:1.7;margin:0 0 6px;font-family:${FONT};">Hijama at haloe is a complementary wellness therapy. It supports how you feel and does not diagnose, treat or replace medical care. Please continue any medication prescribed by your doctor and speak to your GP about any health concern.</p>
                </td>
              </tr>
              ${emailFooter()}`;

  return emailShell(inner);
}
