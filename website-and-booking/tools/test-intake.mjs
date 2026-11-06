// Run: node website-and-booking/tools/test-intake.mjs
// The intake form's rules (phone, date of birth, flags) and the real /intake-submit Function for every form type,
// with Supabase, Resend and push replaced by fakes — nothing is sent or saved anywhere.
import { INTAKE_RULES as R } from '../functions/_intake-rules.js';
import { onRequestPost, onRequestGet } from '../functions/intake-submit.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + extra}`); };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log('Phone numbers (UK)');
for (const [v, want] of [['07700 900123', true], ['+44 7700 900123', true], ['0044 7700 900123', true], ['+44 (0)7700 900123', true], ['01612345678', true],
  ['0770012', false], ['12345', false], ['07700 90012', false], ['0770090012345', false], ['', false], ['+1 415 555 0100', false], ['00 7700 900123', false]]) {
  eq(`UK phone "${v}"`, R.validUkPhone(v), want);
}
eq('emergency contact may be abroad', R.validPhoneAny('+1 415 555 0100'), true);
eq('emergency contact too short', R.validPhoneAny('+1 4'), false);

console.log('\nDate of birth');
const now = new Date('2026-11-06T12:00:00Z');
eq('good date', R.checkDob('1990-05-01', now).ok, true);
eq('future date refused', R.checkDob('2027-01-01', now).reason, 'future');
eq('tomorrow refused', R.checkDob('2026-11-07', now).reason, 'future');
eq('17 years old refused', R.checkDob('2009-11-07', now).reason, 'under18');
eq('turned 18 today allowed', R.checkDob('2008-11-06', now).ok, true);
eq('impossible date (30 Feb)', R.checkDob('1990-02-30', now).reason, 'invalid');
eq('not a date', R.checkDob('banana', now).reason, 'invalid');
eq('empty', R.checkDob('', now).reason, 'missing');
eq('130 years old', R.checkDob('1890-01-01', now).reason, 'too_old');

console.log('\nEmail');
eq('plain', R.validEmail('a@b.co'), true);
eq('no tld', R.validEmail('a@b'), false);
eq('spaces', R.validEmail('a b@c.com'), false);

console.log('\nRisk flags');
eq('nothing flagged', R.riskFlags({ takes_blood_thinners: 'No', is_pregnant: 'No' }, {}), []);
const f = R.riskFlags({ takes_blood_thinners: 'Yes', is_pregnant: 'Yes', diabetes_status: 'Type 2', has_anaemia: 'Yes', bleeding_disorder: 'Yes', infectious_condition: 'Prefer to discuss privately', skin_condition: 'Yes', current_medications: 'I take Warfarin daily' }, { unwell_today: 'Yes', changed: 'Yes' });
ok('every brief risk is flagged', f.length === 10, String(f.length));
ok('clotting watch-list medication spotted', R.riskFlags({ current_medications: 'apixaban 5mg' }, {}).length === 1);

// ---- the Function, with fakes ----
function makeFetch(state) {
  return async (url, init = {}) => {
    const u = String(url), method = (init.method || 'GET').toUpperCase();
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (u.includes('/rest/v1/clients?on_conflict=email')) { state.client = body[0]; return new Response(JSON.stringify([{ id: 11 }]), { status: 201 }); }
    if (u.endsWith('/rest/v1/intake_forms') && method === 'POST') {
      state.inserts.push(body[0]);
      if (state.missingColumns && ('form_type' in body[0])) return new Response(JSON.stringify({ code: 'PGRST204', message: "Could not find the 'form_type' column of 'intake_forms' in the schema cache" }), { status: 400 });
      return new Response(JSON.stringify([{ id: 21 }]), { status: 201 });
    }
    if (u.includes('/storage/v1/object/')) { state.signature = true; return new Response('{}', { status: 200 }); }
    if (u.includes('/rest/v1/intake_forms?id=eq.')) return new Response(null, { status: 204 });
    if (u.includes('/rest/v1/intake_errors')) { state.errors.push(body[0]); return new Response(null, { status: 201 }); }
    if (u.includes('api.resend.com')) { state.emails.push(body); return new Response(JSON.stringify({ id: 'e1' }), { status: 200 }); }
    return new Response('[]', { status: 200 });
  };
}
const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 1)]).toString('base64');
const physical = { full_name: 'Test Person', email: 'Test@Example.com', phone: '07700 900123', date_of_birth: '1990-05-01', age_confirmed: 'Yes',
  emergency_contact_name: 'E', emergency_contact_phone: '07700 900124', consent_accurate_info: 1, consent_complementary: 1, consent_treatment: 1,
  consent_notify_changes: 1, consent_data_storage: 1, consent_modesty: 1, signature_png: png, signature_name: 'Test Person', signature_date: '2026-11-06' };
const PAYLOADS = {
  hijama: { ...physical, form_type: 'hijama', takes_blood_thinners: 'No', infectious_condition: 'No' },
  dry: { ...physical, form_type: 'dry' },
  massage: { ...physical, form_type: 'massage', takes_blood_thinners: 'Yes', main_concern: 'Tight shoulders', answers: { pressure: 'Firm', areas_to_avoid: 'Neck' } },
  coaching: { form_type: 'coaching', full_name: 'Co Ach', email: 'co@example.com', phone: '07700 900125', consent_accurate_info: 1, consent_complementary: 1, consent_data_storage: 1, signature_png: png, signature_name: 'Co Ach', main_concern: 'goals', answers: { goals: 'g', wants: 'w' } },
  notsure: { form_type: 'notsure', full_name: 'No Sure', email: 'ns@example.com', phone: '07700 900126', consent_data_storage: 1, main_concern: 'sore', is_pregnant: 'Yes' },
  checkin: { form_type: 'checkin', full_name: 'Check In', email: 'ck@example.com', consent_accurate_info: 1, answers: { changed: 'Yes', detail: 'New tablets', unwell_today: 'No' } },
  homevisit: { form_type: 'homevisit', full_name: 'Home Visit', email: 'hv@example.com', phone: '07700 900127', consent_data_storage: 1, answers: { address: '1 Test St', pets: 'No' } },
};
async function post(payload, opts = {}) {
  const state = { inserts: [], errors: [], emails: [], missingColumns: !!opts.missingColumns };
  const real = globalThis.fetch; globalThis.fetch = makeFetch(state);
  const pending = [];
  try {
    const res = await onRequestPost({
      request: new Request('https://haloe.test/intake-submit', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'TestBrowser/1.0' }, body: JSON.stringify(payload) }),
      env: { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', RESEND_API_KEY: 'r' },
      waitUntil: (p) => pending.push(p),
    });
    await Promise.all(pending);
    return { status: res.status, body: await res.json(), state };
  } finally { globalThis.fetch = real; }
}

console.log('\n/intake-submit — every form type saves');
for (const [type, payload] of Object.entries(PAYLOADS)) {
  const r = await post(payload);
  ok(`${type}: saved (200)`, r.status === 200, JSON.stringify(r.body));
  ok(`${type}: stored as that type`, r.state.inserts[0] && r.state.inserts[0].form_type === type, JSON.stringify(r.state.inserts[0] && r.state.inserts[0].form_type));
}
{
  const r = await post(PAYLOADS.massage);
  eq('massage: extra answers kept', r.state.inserts[0].answers, { pressure: 'Firm', areas_to_avoid: 'Neck' });
  ok('massage: blood thinners flagged on the record', (r.state.inserts[0].risk_flags || []).some((x) => /blood-thinning/.test(x)));
  ok('massage: Halima emailed, saying it needs a look', r.state.emails.some((e) => e.to.includes('halima@haloe.health') && /needs a look/.test(e.subject)));
  ok('massage: no name or answers in the alert email', !r.state.emails.some((e) => e.to.includes('halima@haloe.health') && /Test Person|Tight shoulders/.test(e.html)));
  ok('massage: the client is not sent the cupping guide', !r.state.emails.some((e) => e.to.includes('test@example.com')));
  eq('email is lower-cased for the client record', r.state.client.email, 'test@example.com');
}
{
  const r = await post(PAYLOADS.hijama);
  ok('hijama: client gets the pre-session guide', r.state.emails.some((e) => e.to.includes('test@example.com')));
  ok('hijama: modesty tick stamped by the server', r.state.inserts[0].consent_modesty === true && !!r.state.inserts[0].consent_modesty_at);
  ok('hijama: signature stored', r.state.signature === true);
}
{
  const r = await post(PAYLOADS.checkin);
  ok('check-in: no date of birth or phone sent to the client record (nothing on file is wiped)', !('date_of_birth' in r.state.client) && !('phone' in r.state.client), JSON.stringify(r.state.client));
  ok('check-in: modesty not stamped', r.state.inserts[0].consent_modesty === false && r.state.inserts[0].consent_modesty_at === null);
  ok('check-in: "something changed" flagged', (r.state.inserts[0].risk_flags || []).some((x) => /changed/.test(x)));
}
{
  const r = await post(PAYLOADS.notsure);
  ok('not sure: pregnancy flagged', (r.state.inserts[0].risk_flags || []).some((x) => /Pregnant/.test(x)));
}

console.log('\n/intake-submit — refusals say why, and are logged');
const tweak = (base, o) => ({ ...base, ...o });
const refusals = [
  ['future date of birth', tweak(PAYLOADS.hijama, { date_of_birth: '2030-01-01' }), /future/],
  ['under 18', tweak(PAYLOADS.dry, { date_of_birth: '2015-01-01' }), /18 or over/],
  ['short phone number', tweak(PAYLOADS.massage, { phone: '0770012' }), /UK phone number/],
  ['bad email', tweak(PAYLOADS.hijama, { email: 'nope' }), /valid email/],
  ['missing signature', tweak(PAYLOADS.hijama, { signature_png: '' }), /sign in the box/],
  ['missing modesty tick', tweak(PAYLOADS.massage, { consent_modesty: 0 }), /tick all required/],
  ['coaching without its statement tick', tweak(PAYLOADS.coaching, { consent_complementary: 0 }), /tick all required/],
  ['unknown form type', tweak(PAYLOADS.hijama, { form_type: 'bogus' }), /isn.t recognised/],
  ['no name', tweak(PAYLOADS.notsure, { full_name: '' }), /full name/],
];
for (const [label, payload, re] of refusals) {
  const r = await post(payload);
  ok(`${label}: refused (400)`, r.status === 400 && re.test(r.body.error || ''), `${r.status} ${JSON.stringify(r.body)}`);
  ok(`${label}: recorded in the failure log`, r.state.errors.length === 1 && r.state.errors[0].stage === 'server' && !!r.state.errors[0].user_agent, JSON.stringify(r.state.errors));
}

console.log('\n/intake-submit — an old cached copy of the form still works');
{
  const legacy = { ...physical }; delete legacy.signature_png; // an old page: no form_type at all
  const r = await post(legacy);
  ok('old payload (no form_type) saves as hijama', r.status === 200 && r.state.inserts[0].form_type === 'hijama', JSON.stringify(r.body));
  const noModesty = { ...legacy, consent_modesty: 0 };
  const r2 = await post(noModesty);
  ok('old payload without the modesty tick is still refused, with a clear message', r2.status === 400 && /tick all required/.test(r2.body.error));
  const lenient = { ...legacy, date_of_birth: '2030-01-01', phone: '123' };
  const r3 = await post(lenient);
  ok('old payload keeps the old, lenient date/phone checks (so nothing already in use breaks)', r3.status === 200);
}

console.log('\n/intake-submit — the new database columns not added yet');
{
  const r = await post(PAYLOADS.massage, { missingColumns: true });
  ok('still saves', r.status === 200, JSON.stringify(r.body));
  ok('retried without the new columns', r.state.inserts.length === 2 && !('form_type' in r.state.inserts[1]));
  ok('the form type and answers are not lost: noted in the classic columns', /Form: Massage/.test(r.state.inserts[1].package) && /Firm/.test(r.state.inserts[1].safety_notes), JSON.stringify([r.state.inserts[1].package, r.state.inserts[1].safety_notes]));
}

console.log('\nOther');
{
  const g = onRequestGet();
  eq('opening /intake-submit in a browser is refused plainly', g.status, 405);
}

console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
