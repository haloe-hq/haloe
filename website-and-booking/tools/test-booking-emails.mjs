// Checks for the booking confirmation experience:   node website-and-booking/tools/test-booking-emails.mjs
//  * the confirmation email's body paragraphs share one style (the "Halima will be in touch" paragraph used to be black),
//  * the Milton Hall arrival wording comes from ONE file (venue-copy.js) for the email and the "You're booked" page,
//  * home-visit bookings never get the Milton Hall text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = []; const check = (n, c, x) => R.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + JSON.stringify(x)));
console.error = () => {}; console.log = () => {};

const { VENUE_COPY } = await import('../functions/_venue-copy.js');
const { notifyBooking } = await import('../functions/_notify.js');
const { BODY_TEXT, FONT } = await import('../functions/_email.js');

const mails = [];
globalThis.fetch = async (u, o = {}) => { if (String(u).includes('resend.com')) mails.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; };
const base = { name: 'Test Client', phone: '07000000000', email: 'client@example.invalid', treatment: 'Face Massage', treatments: ['Face Massage'], durationLabel: '1 hour', date: 'Tue 13 Oct', time: '9:00am', amount: '£32', paymentLabel: 'Paid in full', notes: '', originalAmountLabel: '£40', discountRowLabel: 'GUEST-TEST discount', discountLabel: '−£8', travelLabel: '', travelZone: '', travelPence: 0, slotConflict: false, bookingId: null };
await notifyBooking({ RESEND_API_KEY: 'k' }, { ...base, location: 'clinic', venue: 'Milton Hall, Deansgate', address: 'Milton Hall, 244 Deansgate, Manchester' });
await notifyBooking({ RESEND_API_KEY: 'k' }, { ...base, location: 'mobile', venue: '', address: '1 Example Street', travelLabel: '£15', travelZone: 'A', travelPence: 1500 });
const [clinicCustomer, clinicOwner, mobileCustomer, mobileOwner] = mails.map((m) => m.html);
const para = (html, startsWith) => (html.match(new RegExp('<p style="([^"]*)">' + startsWith)) || [])[1];

const thanks = para(clinicCustomer, 'Thank you for booking with haloe');
const touch = para(clinicCustomer, 'Halima will be in touch personally on WhatsApp');
check('"Halima will be in touch…" has the same inline style as "Thank you for booking…" apart from its bottom margin', !!thanks && !!touch && thanks.replace('margin:0;', '') === touch.replace('margin:0 0 16px;', ''), [thanks, touch]);
check('…which is the muted body colour, not black (#0D0D0D)', touch && touch.startsWith('color:' + BODY_TEXT + ';') && !/0D0D0D/i.test(touch), touch);
check('…in the same font family, size and line height', touch && touch.includes('font-size:15px;line-height:1.75;') && touch.includes('font-family:' + FONT), touch);
check('no stray black body paragraph is left in the customer email (only the greeting and headings are dark)', (clinicCustomer.match(/<p style="color:#0D0D0D;[^"]*">([^<]{0,30})/g) || []).every((p) => /Dear |Getting there/.test(p)), clinicCustomer.match(/<p style="color:#0D0D0D;[^"]*">([^<]{0,30})/g));
check('owner "New booking" email has no black body paragraph slip', !/<p style="color:#0D0D0D;/.test(clinicOwner), 0);

check('clinic email carries the shared arrival wording exactly', clinicCustomer.includes(VENUE_COPY.arrivalEmail), 0);
check('home-visit email has no Milton Hall arrival text', !/Milton Hall|concierge|Musa|Room 4/.test(mobileCustomer), 0);

check('the room number and floor are never given (brand document)', !/Room \d|\d(st|nd|rd|th) floor|\bfloor\b/i.test(VENUE_COPY.arrivalShort + ' ' + VENUE_COPY.arrivalEmail), 0);
check('short wording is exactly what the success page should say', VENUE_COPY.arrivalShort === "Milton Hall, 244 Deansgate. Give your name to Musa at the concierge desk and ask for haloe — he'll point you the way. Lift access is available.", VENUE_COPY.arrivalShort);
check('both versions are built from the same facts (address, concierge)', ['244 Deansgate', 'Musa'].every((t) => VENUE_COPY.arrivalShort.includes(t) && VENUE_COPY.arrivalEmail.includes(t)), 0);

const page = fs.readFileSync(path.join(root, 'booking-confirmed.html'), 'utf8');
check('the success page loads /venue-copy.js and uses VENUE_COPY.arrivalShort for clinic bookings', /<script src="\/venue-copy\.js(\?v=\d+)?"><\/script>/.test(page) && /bookingLocation === 'clinic'[\s\S]{0,400}VENUE_COPY\.arrivalShort/.test(page), 0);
check('the old out-of-date "reception … ground floor" wording is gone from the page', !/Check in at reception|on the ground floor/.test(page), 0);
check('home-visit step 2 is left as it was ("She comes to you.")', page.includes('<span id="balance-note">She comes to you.</span>'), 0);

console.log = (...a) => process.stdout.write(a.join(' ') + '\n');
console.log(R.join('\n'));
console.log(`\n${R.length} checks — ${R.filter((r) => r.startsWith('PASS')).length} passed, ${R.filter((r) => r.startsWith('FAIL')).length} failed`);
process.exit(R.some((r) => r.startsWith('FAIL')) ? 1 : 0);
