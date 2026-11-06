// "Modesty and care" checks:   node website-and-booking/tools/test-care-copy.mjs
//  * the wording is one shared constant (care-copy.js) and says exactly what was agreed,
//  * every place reads it: booking page, intake form, confirmation email, both FAQs (+ FAQPage JSON-LD) — static FAQ text must match,
//  * the intake tick is required and the server saves it with a server-side timestamp (and never defaults it),
//  * the only gender question is the OPTIONAL one on the intake form (6 Nov 2026); it only decides whether the navel-to-knees
//    sentence is shown. The booking page and checkout never ask it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = []; const check = (n, c, x) => R.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + JSON.stringify(x)));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const log = console.log; console.error = () => {}; console.log = () => {};

const { CARE_COPY } = await import('../functions/_care-copy.js');
const BODY = 'For modesty and professional care, I do not treat the area between the navel and the knees on male clients. That area stays covered throughout the session. Everything else is treated as booked.';
check('heading', CARE_COPY.heading === 'Modesty and care', CARE_COPY.heading);
check('body', CARE_COPY.body === BODY, CARE_COPY.body);
check('tick label', CARE_COPY.tick === 'I understand and agree', CARE_COPY.tick);
check('email line', CARE_COPY.emailLine === 'A note on care: for male clients, the area between the navel and the knees is not treated and stays covered.', CARE_COPY.emailLine);
check('FAQ question + answer (answer = body)', CARE_COPY.faqQuestion === 'Is any area not treated?' && CARE_COPY.faqAnswer === BODY, 0);
check('hint', CARE_COPY.hint === 'Please tick the box above to continue.', CARE_COPY.hint);
check('booking-page line under the pay button', CARE_COPY.payHint === 'You will be asked to confirm this on your intake form.', CARE_COPY.payHint);

// ---- booking page
const book = read('book.html');
// The page CSS uses design tokens (tokens.css); expand them so these checks still read real values.
const TOK = Object.fromEntries([...read('tokens.css').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const bookR = book.replace(/var\((--[\w-]+)\)/g, (m, k) => TOK[k] || m);
check('booking page loads /care-copy.js and fills heading, body and the pay hint from it', book.includes('<script src="/care-copy.js"></script>') && /CARE_COPY[\s\S]{0,300}care-h[\s\S]{0,200}care-b[\s\S]{0,200}care-pay-hint/.test(book), 0);
const iCard = book.indexOf('id="care-card"'), iPay = book.indexOf('id="btn-full"'), iHint = book.indexOf('id="care-pay-hint"');
check('card sits before the pay button, hint directly under it', iCard > 0 && iCard < iPay && iPay < iHint, [iCard, iPay, iHint]);
check('card is on the review step (panel-5), not a pop-up/modal', book.indexOf('id="panel-5"') < iCard && iCard < book.indexOf('id="confirmation"') && !/care-card[^>]*(modal|dialog|popup)/i.test(book), 0);
const css = (bookR.match(/\.care-card \{[^}]*\}/) || [''])[0];
check('card styles: sand #EFE7D8, 28px radius, 16px padding, #4A3F2E text', /#EFE7D8/i.test(css) && /border-radius: 28px/.test(css) && /padding: 16px/.test(css) && /#4A3F2E/i.test(css), css);
check('3px gold (#C8A96E) left edge, 40px white circle', /\.care-card::before \{[^}]*width: 3px[^}]*#C8A96E|\.care-card::before \{[^}]*#C8A96E[^}]*width: 3px/i.test(bookR) && /\.care-ico \{[^}]*width: 40px[^}]*height: 40px[^}]*#FFFFFF/i.test(bookR), 0);
check('heading 15px/600, body 14px/1.5', /\.care-h \{[^}]*font-size: 15px[^}]*font-weight: 600/.test(bookR) && /\.care-b \{[^}]*font-size: 14px[^}]*line-height: 1\.5/.test(bookR), 0);
check("towel icon = three stacked rounded rects in gold line", !!book.match(/<svg[^>]*stroke="#C8A96E"[^>]*>(<rect[^>]*rx="2"\/>){3}<\/svg>/), 0);
check('no red/green/warning marks on the card', !/⚠/.test(book.slice(iCard, iPay)) && !/\.care-(card|h|b|ico)[^{]*\{[^}]*(red|green|#c97a6e|#E5736A)/i.test(book), 0);

// ---- intake form
const intake = read('intake.html');
check('intake loads /care-copy.js; heading and tick come from it; everyone sees the neutral line, and the navel-to-knees sentence (CARE_COPY.body) only for male clients', intake.includes('<script src="/care-copy.js"></script>') && /careHead'\)\.textContent = CARE\.heading/.test(intake) && /careTick'\)\.textContent = CARE\.tick/.test(intake) && /CARE\.generalBody/.test(intake) && /male \? ' ' \+ \(CARE\.body/.test(intake), 0);
check('the neutral line does not mention the navel or knees', !!CARE_COPY.generalBody && !/navel|knee/i.test(CARE_COPY.generalBody), CARE_COPY.generalBody);
check('tick box exists, NOT pre-checked, required (step 5) and sent in collect()', /<input type="checkbox" id="consent_modesty">/.test(intake) && !/id="consent_modesty"[^>]*checked/.test(intake) && /\{ key:'consent_modesty', type:'consent' \}/.test(intake) && /consent_modesty: checkVal\('consent_modesty'\)/.test(intake), 0);
check('Submit starts disabled and is toggled by the tick', /id="submitBtn"[^>]*\bdisabled/.test(intake) && /submitBtn\.disabled = need/.test(intake) && /typeHas\('modesty'\)/.test(intake), 0);
check('28px tick on a 56px row', /\.care-field \.check-item \{ min-height: 56px/.test(intake) && /\.care-field \.check-item \.check-box \{ width: 28px; height: 28px/.test(intake), 0);
const collectBlock = intake.slice(intake.indexOf('function collectBase()'), intake.indexOf('var submitBtn'));
const keys = (collectBlock.match(/^ {6}[a-z_]+:/gm) || []).length;
check('payload is now 43 keys', keys === 43, keys);
const ids = (collectBlock.match(/(?:textVal|radioVal|checkVal|allChecked)\('([a-z_]+)'\)/g) || []).map((m) => m.match(/'([a-z_]+)'/)[1]);
check('every id/name collect() reads exists in the DOM', ids.every((id) => new RegExp(`(id|name)="${id}"`).test(intake)), ids.filter((id) => !new RegExp(`(id|name)="${id}"`).test(intake)));

// ---- intake-submit: required + server timestamp
const posted = [];
globalThis.fetch = async (u, o = {}) => {
  if (String(u).includes('/rest/v1/intake_forms') && o.method === 'POST') posted.push(JSON.parse(o.body)[0]);
  const rows = String(u).includes('/rest/v1/clients') ? [{ id: 7 }] : [{ id: 9 }];
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => rows, text: async () => JSON.stringify(rows) };
};
const { onRequestPost } = await import('../functions/intake-submit.js');
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const base = { full_name: 'Test Person', email: 'p@example.invalid', consent_accurate_info: true, consent_complementary: true, consent_treatment: true, consent_notify_changes: true, consent_data_storage: true, signature_name: 'T', signature_date: '2026-10-09' };
const post = (b) => onRequestPost({ request: new Request('https://x/intake-submit', { method: 'POST', body: JSON.stringify(b) }), env });
const missing = await post(base), unticked = await post({ ...base, consent_modesty: false });
check('submission without the tick is refused (400) and nothing is written', missing.status === 400 && unticked.status === 400 && posted.length === 0, [missing.status, unticked.status, posted.length]);
const t0 = Date.now(); const okRes = await post({ ...base, consent_modesty: true, consent_modesty_at: '1999-01-01T00:00:00Z' });
const row = posted[0] || {};
check('ticked submission is saved with consent_modesty = true', okRes.status === 200 && row.consent_modesty === true, [okRes.status, row.consent_modesty]);
check('…and a server-side timestamp (browser value ignored)', typeof row.consent_modesty_at === 'string' && Math.abs(Date.parse(row.consent_modesty_at) - t0) < 10000 && !row.consent_modesty_at.startsWith('1999'), row.consent_modesty_at);

// ---- confirmation email
const { notifyBooking } = await import('../functions/_notify.js');
const { BODY_TEXT, FONT } = await import('../functions/_email.js');
const mails = [];
globalThis.fetch = async (u, o = {}) => { if (String(u).includes('resend.com')) mails.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; };
const d = { name: 'Test Client', phone: '07000000000', email: 'client@example.invalid', treatment: 'Face Massage', treatments: ['Face Massage'], durationLabel: '1 hour', date: 'Tue 13 Oct', time: '9:00am', amount: '£32', paymentLabel: 'Paid in full', notes: '', originalAmountLabel: '£40', discountRowLabel: 'GUEST-TEST discount', discountLabel: '−£8', travelLabel: '', travelZone: '', travelPence: 0, slotConflict: false, bookingId: null };
await notifyBooking({ RESEND_API_KEY: 'k' }, { ...d, location: 'clinic', venue: 'Milton Hall, Deansgate', address: 'Milton Hall, 244 Deansgate' });
const html = mails[0].html;
const m = html.match(/<p style="([^"]*)">A note on care:[^<]*<\/p>/);
check('customer email carries the shared one-line wording', html.includes(CARE_COPY.emailLine), 0);
check('…in the muted body colour and font, same as the other paragraphs', m && m[1].startsWith('color:' + BODY_TEXT + ';') && m[1].includes('font-family:' + FONT), m && m[1]);
check('…placed after the booking details card, before the closing note', html.indexOf('Total paid') < html.indexOf(CARE_COPY.emailLine) && html.indexOf(CARE_COPY.emailLine) < html.indexOf('Halima will be in touch'), 0);
check('owner notification does not repeat it', !mails.slice(1).some((x) => x.html.includes(CARE_COPY.emailLine)), 0);

// ---- FAQs (static text must equal the shared constants)
const idx = read('index.html'), hm = read('hijama-manchester.html');
check('homepage FAQ has the question and the exact answer', idx.includes(`<h3>${CARE_COPY.faqQuestion}</h3>`) && idx.includes(`<p>${CARE_COPY.faqAnswer}</p>`), 0);
check('Hijama Manchester FAQ has the question and the exact answer', hm.includes(`<summary>${CARE_COPY.faqQuestion}</summary>\n      <p>${CARE_COPY.faqAnswer}</p>`), 0);
const ld = JSON.parse(hm.match(/<script type="application\/ld\+json">\s*(\{[\s\S]*?"FAQPage"[\s\S]*?\})\s*<\/script>/)[1]);
const q = ld.mainEntity.find((e) => e.name === CARE_COPY.faqQuestion);
check('FAQPage JSON-LD matches the visible text exactly', q && q.acceptedAnswer.text === CARE_COPY.faqAnswer, q);

// ---- gender: optional, intake only
check('gender is asked only on the intake form, and only as an optional question', ![book, read('functions/create-checkout.js')].some((t) => /\bgender\b|name="sex"|id="sex"/i.test(t)) && /data-group="gender"/.test(intake) && !/\{ key:'gender'/.test(intake), 0);

console.log = log;
for (const l of R) console.log(l);
const bad = R.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${R.length} checks — ${R.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
