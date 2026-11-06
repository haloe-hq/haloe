// Web Push for admin alerts — Cloudflare-Workers-compatible: WebCrypto + fetch only, no Node APIs.
//   * message encryption: RFC 8291 (aes128gcm content coding, RFC 8188)
//   * sender identification: VAPID, RFC 8292 (ES256 JWT)
// Admin events: reschedule accepted, new booking, intake form completed, client photo (+ a test alert).
// Client event: aftercare reminders (notifyClient).
// The `_` prefix keeps this file from becoming a route.
//
// Env (Cloudflare Pages secrets — see CLAUDE.md "Push notifications"):
//   VAPID_PUBLIC_KEY   base64url 65-byte P-256 point (same value as VAPID_PUBLIC in app/index.html)
//   VAPID_PRIVATE_KEY  base64url 32-byte private scalar  (SECRET)
//   VAPID_SUBJECT      optional, defaults to mailto:halima@haloe.health
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (already set) — to read subscriptions and clean up dead ones
//
// PRIVACY: what goes in a push shows on a lock screen. The payload is only a fixed title, a short body such
// as "Reschedule accepted · Tue 13 Oct, 6:30pm", and an in-app URL. Never a name, treatment or clinical detail.
//
// A push failure must NEVER break the thing that triggered it (an accept, a booking): every public function
// here catches its own errors and returns a summary instead of throwing.
import { sbRequest } from './_supabase.js';

const enc = new TextEncoder();

export const b64uToBytes = (s) => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
export const bytesToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, lengthBytes * 8));
}

/**
 * RFC 8291 encryption of `plaintext` (Uint8Array) for one subscription { p256dh, auth } (both base64url).
 * Returns the full request body: salt(16) | rs(4) | idlen(1) | as_public(65) | ciphertext.
 * `opts.salt` / `opts.ephemeral` exist only so tests can be deterministic.
 */
export async function encryptPayload(sub, plaintext, opts = {}) {
  const uaPublic = b64uToBytes(sub.p256dh);               // 65 bytes, uncompressed point
  const authSecret = b64uToBytes(sub.auth);               // 16 bytes
  const asKeys = opts.ephemeral || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(plaintext, Uint8Array.of(2));      // 0x02 = delimiter of the final (only) record
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, record));
  return concat(salt, Uint8Array.of(0, 0, 0x10, 0), Uint8Array.of(asPublic.length), asPublic, ct);   // rs = 4096
}

/** VAPID `Authorization` header value for a push endpoint (RFC 8292). */
export async function vapidAuthorization(env, endpoint, nowSec = Math.floor(Date.now() / 1000)) {
  const pub = b64uToBytes(env.VAPID_PUBLIC_KEY);
  const jwk = { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE_KEY, x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:halima@haloe.health' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));   // raw r||s, as JWT wants
  return `vapid t=${head}.${claims}.${bytesToB64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/** Send one encrypted push. Resolves { status, ok }; rejects only on a network error. */
export async function sendWebPush(env, sub, payloadObj, { ttl = 3600, urgency = 'normal' } = {}) {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(payloadObj)));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(env, sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return { status: res.status, ok: res.ok };
}

/** "Tue 13 Oct, 6:30pm" from an ISO date + minutes from midnight. */
export function fmtWhen(isoDate, startMin) {
  const day = new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const h = Math.floor(startMin / 60), m = startMin % 60;
  return `${day}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

/**
 * Send an alert to the admin's subscribed devices.
 *   kind: 'reschedule' | 'booking' | 'intake' (respects each device's switch) | 'test' (ignores the switches;
 *         pass userId — and optionally endpoint — to target the caller's own device)
 * Dead subscriptions (push service answers 404/410) are deleted. Never throws.
 * Returns { sent, removed, failed } or { skipped: reason }.
 */
/** Deliver one payload to a list of subscription rows; delete the dead ones (404/410). Never throws. */
async function deliver(env, subs, payload) {
  const out = { sent: 0, removed: 0, failed: 0 };
  await Promise.all((subs || []).map(async (s) => {
    try {
      const r = await sendWebPush(env, s, payload);
      if (r.ok) {
        out.sent++;
        await sbRequest(env, { path: `/rest/v1/push_subscriptions?id=eq.${s.id}`, method: 'PATCH', prefer: 'return=minimal', body: { last_ok: new Date().toISOString() } }).catch(() => {});
      } else if (r.status === 404 || r.status === 410) {
        out.removed++;     // the device unsubscribed or the subscription expired — stop trying
        await sbRequest(env, { path: `/rest/v1/push_subscriptions?id=eq.${s.id}`, method: 'DELETE', prefer: 'return=minimal' }).catch(() => {});
      } else {
        out.failed++;
        console.error('push: service answered', r.status, 'for subscription', s.id);
      }
    } catch (err) {
      out.failed++;
      console.error('push: send failed for subscription', s.id, err);
    }
  }));
  return out;
}

export async function notifyAdmins(env, { kind, body, url, tag, userId, endpoint }) {
  try {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { skipped: 'vapid_not_configured' };
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'supabase_not_configured' };

    // Only ever send to admin accounts, even if a stray row existed (clients may now store their own devices for
    // aftercare reminders — those rows belong to client accounts and are never selected here).
    const admins = await sbRequest(env, { path: '/rest/v1/profiles?select=id&role=eq.admin', method: 'GET' });
    const ids = (admins || []).map((a) => a.id).filter((id) => !userId || id === userId);
    if (!ids.length) return { sent: 0, removed: 0, failed: 0 };

    let q = `/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth&user_id=in.(${ids.join(',')})`;
    if (kind === 'reschedule') q += '&notify_reschedule=eq.true';
    if (kind === 'booking') q += '&notify_booking=eq.true';
    if (kind === 'intake') q += '&notify_intake=eq.true';
    if (kind === 'photo') q += '&notify_photo=eq.true';
    if (kind === 'unlinked') q += '&notify_unlinked=eq.true';
    if (endpoint) q += `&endpoint=eq.${encodeURIComponent(endpoint)}`;
    const subs = await sbRequest(env, { path: q, method: 'GET' });
    return await deliver(env, subs, { title: 'haloe', body, url, tag });
  } catch (err) {
    console.error('push: notifyAdmins failed:', err);
    return { skipped: 'error' };
  }
}

/**
 * A push to a CLIENT's own device(s) (aftercare reminders) — only accounts with role 'client' linked to this client
 * record, and only devices that client chose to register. Never throws.
 */
export async function notifyClient(env, clientId, { body, url, tag }) {
  try {
    if (!clientId) return { skipped: 'no_client' };
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { skipped: 'vapid_not_configured' };
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { skipped: 'supabase_not_configured' };
    const profs = await sbRequest(env, { path: `/rest/v1/profiles?select=id&role=eq.client&client_id=eq.${Number(clientId)}`, method: 'GET' });
    const ids = (profs || []).map((p) => p.id);
    if (!ids.length) return { sent: 0, removed: 0, failed: 0 };
    const subs = await sbRequest(env, { path: `/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth&user_id=in.(${ids.join(',')})`, method: 'GET' });
    return await deliver(env, subs, { title: 'haloe', body, url, tag });
  } catch (err) {
    console.error('push: notifyClient failed:', err);
    return { skipped: 'error' };
  }
}

/** A client accepted a reschedule. `b` is accept_reschedule()'s result ({ id, date, start_min, ... }). */
export function pushRescheduleAccepted(env, b) {
  return notifyAdmins(env, {
    kind: 'reschedule',
    body: `Reschedule accepted · ${fmtWhen(b.date, b.start_min)}`,
    url: `/app/#/brief/b/${b.id}`,
    tag: `reschedule-${b.id}`,
  });
}

/** A new booking was confirmed (paid or £0). Looks the time up from the booking row; falls back to a plain line. */
export async function pushNewBooking(env, bookingId) {
  try {
    let when = '', url = '/app/#/today';
    if (bookingId) {
      const rows = await sbRequest(env, { path: `/rest/v1/bookings?select=booking_date,start_min&id=eq.${Number(bookingId)}`, method: 'GET' });
      if (rows && rows[0]) { when = fmtWhen(rows[0].booking_date, rows[0].start_min); url = `/app/#/brief/b/${Number(bookingId)}`; }
    }
    return await notifyAdmins(env, { kind: 'booking', body: when ? `New booking · ${when}` : 'New booking', url, tag: bookingId ? `booking-${bookingId}` : 'booking' });
  } catch (err) {
    console.error('push: new-booking alert failed:', err);
    return { skipped: 'error' };
  }
}

/* ------------------------------------------------------------------ */
/* Intake form completed                                               */
/* ------------------------------------------------------------------ */

// MIRROR of the "Act on this" rules in app/index.html (buildFlags): the browser page can't be imported here,
// so the lists are kept in step by hand — the tests compare them. ONE DELIBERATE DIFFERENCE: the app's card also flags a
// blank main concern, but the PUSH does not — a blank concern on its own never raises an alert.
// The rule decides ONLY whether the push says "· needs a look"; the reason is never put in the push.
export const SAFETY_KEYS = ['is_pregnant', 'breastfeeding', 'takes_blood_thinners', 'bleeding_disorder', 'diabetes_status', 'chemo_or_radiotherapy', 'has_anaemia', 'infectious_condition', 'recent_surgery', 'blood_pressure', 'skin_condition', 'pacemaker_epilepsy'];
export const CLOT_RE = /warfarin|apixaban|eliquis|rivaroxaban|xarelto|clopidogrel|plavix|aspirin|tranexamic(?: acid)?|cyklokapron/i;
const last10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const trim = (v) => (v == null ? '' : String(v).trim());

/** Would this intake raise an "Act on this" alert? (Safety answers, clotting medication, emergency contact = own number.) `intake` uses the intake_forms column names. */
export function intakeNeedsLook(intake, clientPhone) {
  if (SAFETY_KEYS.some((k) => { const v = trim(intake[k]); return v !== '' && v.toLowerCase() !== 'no'; })) return true;   // any screening answer other than "No"
  if (trim(intake.current_medications) && CLOT_RE.test(intake.current_medications)) return true;                           // clotting-related medication
  const own = last10(clientPhone), emer = last10(intake.emergency_contact_phone);
  if (own && emer && own === emer) return true;                                                                             // emergency contact is their own number
  return false;
}

/** A client completed the intake form. Opens that client's brief. Never throws. */
export async function pushIntakeCompleted(env, { clientId, intake, clientPhone, riskFlags }) {
  try {
    let needs = false;
    try { needs = intakeNeedsLook(intake || {}, clientPhone); } catch (e) { needs = false; }
    if (Array.isArray(riskFlags) && riskFlags.length) needs = true; // any flagged answer (blood thinners, pregnancy, diabetes...) is worth a look
    return await notifyAdmins(env, {
      kind: 'intake',
      body: needs ? 'Intake form completed · needs a look' : 'Intake form completed',
      url: clientId ? `/app/#/brief/c/${Number(clientId)}` : '/app/#/clients',
      tag: clientId ? `intake-${Number(clientId)}` : 'intake',
    });
  } catch (err) {
    console.error('push: intake alert failed:', err);
    return { skipped: 'error' };
  }
}

/** A client sent Halima a photo. No name, no photo — taps through to that client's brief. */
export function pushPhotoSent(env, clientId) {
  return notifyAdmins(env, {
    kind: 'photo',
    body: 'A client sent a photo',
    url: clientId ? `/app/#/brief/c/${Number(clientId)}` : '/app/#/clients',
    tag: clientId ? `photo-${Number(clientId)}` : 'photo',
  });
}

/** Someone signed in with an email that matches no client. Lock-screen safe: no email, no name — taps through to Clients. */
export function pushUnlinkedSignIn(env) {
  return notifyAdmins(env, { kind: 'unlinked', body: 'A sign-in needs matching', url: '/app/#/clients', tag: 'unlinked' });
}
