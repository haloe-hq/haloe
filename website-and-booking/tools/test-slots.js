// node tools/test-slots.js
// Tests for the dynamic slot generation logic in functions/_slots.js.
// Plain-node, no test framework needed.

import fs from 'node:fs';
import vm from 'node:vm';
import { generateSlots, startGrid, groupSlots, TURNAROUND_MIN, minutesToLabel } from '../functions/_slots.js';
import { resolveCart, cartFitsLocation, formatDuration, SERVICES as SERVER_SERVICES, netPrice } from '../functions/_services.js';
// Prices are asserted through netPrice() so the tests follow PROMO_DISCOUNT (0.2 since Oct 2026).
const P = (cat, name) => Math.round(netPrice(SERVER_SERVICES[cat].find((x) => x.name === name)) * 100);
import { applyDiscount } from '../functions/_discounts.js';
import { CLINIC_RULES } from '../functions/_clinic.js';
import { onRequestPost as createCheckout } from '../functions/create-checkout.js';

let pass = 0, fail = 0;
function ok(label, expr) {
  if (expr) { pass++; console.log(`  ✓  ${label}`); }
  else       { fail++; console.error(`  ✗  FAIL: ${label}`); }
}
function eq(label, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log(`  ✓  ${label}`); }
  else { fail++; console.error(`  ✗  FAIL: ${label}\n       got:  ${JSON.stringify(a)}\n       want: ${JSON.stringify(b)}`); }
}

// ── Clinic grid: 9:00–19:30 every 30 min ──────────────────────────────────
const CLINIC_DAY = 2; // Tuesday
const MOBILE_DAY = 4; // Thursday

console.log('\nClinic grid (empty Tuesday)');
const clinicGrid = startGrid('clinic', CLINIC_DAY);
// 9:00 = 540 min, 19:30 = 1170 min, step 30 → (1170-540)/30 + 1 = 22 slots
eq('count 22', clinicGrid.length, 22);
eq('first 9:00 (540)', clinicGrid[0], 540);
eq('last 19:30 (1170)', clinicGrid[clinicGrid.length - 1], 1170);

console.log('\nSlot availability — empty Tuesday, any duration');
const slotsEmpty = generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: 60 });
eq('22 slots when empty', slotsEmpty.length, 22);
ok('9:00 offered', slotsEmpty.includes(540));
ok('9:30 offered', slotsEmpty.includes(570));
ok('19:30 offered (last-start rule)', slotsEmpty.includes(1170));

console.log('\nWith 10:00–11:00 booked (600–660), 1 h treatment');
const busy1 = [{ s: 600, e: 660 }]; // 10:00–11:00
const slots1 = generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: 60, busy: busy1 });
// NOTE: every slot now blocks treatment + TURNAROUND_MIN (15), so a 60 min start blocks 75 min.
// 9:00 → end 10:15 → overlaps 600–660 → removed (the buffer pushes it in)
// 9:30 → end 10:30 → overlaps busy 600–660? 570+60=630 > 600 → yes, removed
// 10:00 → end 11:00 → overlaps exactly → yes, removed
// 10:30 → end 11:30 → start 630 < 660 → yes, removed
// 11:00 → end 12:00 → start 660 not < 660 → FREE
ok('9:00 removed (60 + 15 buffer runs into 10:00)', !slots1.includes(540));
ok('9:30 removed (end overlaps busy)', !slots1.includes(570));
ok('10:00 removed (starts in busy)', !slots1.includes(600));
ok('10:30 removed (overlaps busy end)', !slots1.includes(630));
ok('11:00 available', slots1.includes(660));
ok('19:30 still available', slots1.includes(1170));
eq('18 slots remain', slots1.length, 18);

console.log('\nWith same 10:00–11:00 booked, 1 h 30 treatment');
const slots2 = generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: 90, busy: busy1 });
// 9:00 → end 10:30 → overlaps (540+90=630 > 600) → removed
// 9:30 → end 11:00 → overlaps 600–660? 570+90=660 > 600 → yes, removed
// 10:00 → 600+90=690 > 600 → removed
// 10:30 → 630+90=720 > 600 → removed
// 11:00 → 660+90=750, does NOT overlap (660 < 660 is false) → FREE
ok('9:00 removed (1h30)', !slots2.includes(540));
ok('9:30 removed (1h30)', !slots2.includes(570));
ok('10:00 removed (1h30)', !slots2.includes(600));
ok('10:30 removed (1h30)', !slots2.includes(630));
ok('11:00 available (1h30)', slots2.includes(660));
ok('19:30 NOT offered for 1h30 (19:30 + 90 + 15 = 21:15 would overrun the 9pm lock-up)', !slots2.includes(1170));
eq('17 slots remain (1h30)', slots2.length, 17);

console.log('\nSame-day minimum notice');
// Pretend nowMin = 570 (09:30); notice = 120 min → cutoff 690 (11:30)
// Slots 570–690 should be hidden
const slotsNotice = generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: 60, nowMin: 570 });
ok('9:30 hidden (within notice)', !slotsNotice.includes(570));
ok('11:00 hidden (within notice)', !slotsNotice.includes(660));
ok('11:30 shown (exactly at cutoff)', slotsNotice.includes(690));
ok('19:30 still offered', slotsNotice.includes(1170));

console.log('\nClosed day');
const sunGrid = startGrid('clinic', 0); // clinic is closed on Sundays
eq('clinic closed on Sunday', sunGrid.length, 0);
const sunSlots = generateSlots({ location: 'clinic', weekday: 0, durationMin: 60 });
eq('no slots on closed day', sunSlots.length, 0);

console.log('\nMobile grid (Thursday)');
const mobGrid = startGrid('mobile', MOBILE_DAY);
// 10:00 = 600, 20:00 = 1200, (1200-600)/30+1 = 21 slots
eq('mobile: 21 slots', mobGrid.length, 21);
eq('mobile: first 10:00 (600)', mobGrid[0], 600);
eq('mobile: last 20:00 (1200)', mobGrid[mobGrid.length - 1], 1200);

console.log('\nGrouping');
const { morning, afternoon, evening } = groupSlots([540, 690, 780, 840, 900, 1020, 1170]);
// 540=9:00 (morning), 690=11:30, 780=13:00 (afternoon), ...
eq('morning contains 9:00 and 11:30', morning, [540, 690]);
// 1020 = 17:00 → t >= 17*60 is true → evening bucket
eq('afternoon contains 13:00–16:30', afternoon, [780, 840, 900]);
eq('evening contains 17:00 and 19:30', evening, [1020, 1170]);

// ── Verification output for Tue 6 Oct (empty) ─────────────────────────────
console.log('\nVerification: Tue 6 Oct — empty, any duration (22 slots)');
const tue6Oct = generateSlots({ location: 'clinic', weekday: 2, durationMin: 60 });
console.log('  ' + tue6Oct.map(m => {
  const h24 = Math.floor(m/60), mm = String(m%60).padStart(2,'0');
  const p = h24 >= 12 ? 'pm' : 'am';
  let h12 = h24 % 12; if (!h12) h12 = 12;
  return `${h12}:${mm} ${p}`;
}).join('  '));
eq('22 slots', tue6Oct.length, 22);
ok('first slot is 9:00 am', tue6Oct[0] === 540);

// With the 10:00–11:00 block → 9:00, 9:30, 10:00, 10:30 removed (18 slots) — the 15 min turnaround removes 9:00 too
console.log('\nVerification: Tue 6 Oct — 10:00 Full Back (60 min) booked');
const withFullBack = generateSlots({ location: 'clinic', weekday: 2, durationMin: 60, busy: [{ s: 600, e: 660 }] });
console.log('  ' + withFullBack.map(m => {
  const h24 = Math.floor(m/60), mm = String(m%60).padStart(2,'0');
  const p = h24 >= 12 ? 'pm' : 'am';
  let h12 = h24 % 12; if (!h12) h12 = 12;
  return `${h12}:${mm} ${p}`;
}).join('  '));
eq('18 slots after 1h booking (9:00 now blocked by the buffer)', withFullBack.length, 18);
ok('First available is 11:00', withFullBack[0] === 660);

// ── Multi-treatment bookings ──────────────────────────────────────────────
console.log('\nMulti-treatment: resolveCart');
const two = resolveCart([{ name: 'Face Massage', category: 'massage' }, { name: 'Head Massage', category: 'massage' }]);
ok('two treatments resolve', two.ok);
eq('combined price = Face + Head Massage', two.totalPence, P('massage','Face Massage') + P('massage','Head Massage'));
eq('combined duration 120 min', two.totalMin, 120);
eq('duration label', formatDuration(two.totalMin), '2 hours');

const wetTwo = resolveCart([{ name: 'Full Back', category: 'wet' }, { name: 'Head & Scalp', category: 'wet' }]);
eq('wet pair priced per category', wetTwo.totalPence, P('wet','Full Back') + P('wet','Head & Scalp'));
eq('wet pair 120 min', wetTwo.totalMin, 120);
const crossCat = resolveCart([{ name: 'Full Back', category: 'dry' }, { name: 'Full Back', category: 'wet' }]);
eq('same name in dry + wet are two distinct treatments', crossCat.totalPence, P('dry','Full Back') + P('wet','Full Back'));

const single = resolveCart([{ name: 'Full Back', category: 'wet' }]);
eq('single treatment unchanged: net price, 60 min', [single.totalPence, single.totalMin], [P('wet','Full Back'), 60]);
eq('duplicate is collapsed', resolveCart([{ name: 'Face Massage', category: 'massage' }, { name: 'Face Massage', category: 'massage' }]).items.length, 1);
eq('unknown treatment rejected', resolveCart([{ name: 'Nope', category: 'massage' }]).error, 'unknown_treatment');
eq('wrong category rejected (no fallback)', resolveCart([{ name: 'Face Massage', category: 'wet' }]).error, 'unknown_treatment');
eq('empty cart rejected', resolveCart([]).error, 'no_treatments');
eq('package cannot be combined', resolveCart([{ name: 'Cycle Comfort', category: 'packages' }, { name: 'Face Massage', category: 'massage' }]).error, 'package_not_combinable');
ok('a package alone is fine', resolveCart([{ name: 'Cycle Comfort', category: 'packages' }]).ok);

console.log('\nMulti-treatment: a code percentage on the combined total');
const d = applyDiscount(8000, 20);
eq('20% off £80 = £16 off, £64 to pay', [d.discountPence, d.finalPence], [1600, 6400]);

console.log('\nMulti-treatment: slots fit the COMBINED duration (Face + Head Massage = 120 min)');
// 10:00–11:00 booked (600–660)
const slotsTwo = generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: two.totalMin, busy: busy1 });
ok('9:30 removed (would run to 11:00, into the booking)', !slotsTwo.includes(570));
ok('11:00 offered (starts as the booking ends)', slotsTwo.includes(660));
// 11:00–12:00 booked: a lone 45 min treatment fits at 10:00 (ends 10:45); the pair (120 min) does not
const busy11 = [{ s: 660, e: 720 }];
ok('a lone 45 min treatment fits at 10:00', generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: 45, busy: busy11 }).includes(600));
ok('the 120 min pair does NOT fit at 10:00', !generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: two.totalMin, busy: busy11 }).includes(600));
ok('the 120 min pair does NOT fit at 9:00 (120 + 15 buffer runs into the 11:00 booking)', !generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: two.totalMin, busy: busy11 }).includes(540));
ok('the 120 min pair does NOT fit at 9:30', !generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: two.totalMin, busy: busy11 }).includes(570));
// 12:00–12:30 booked: a 90 min session can't start 10:30–12:00, but 45 min can start 11:00 → 11:45
const busyNoon = [{ s: 720, e: 750 }];
const s90 = generateSlots({ location: 'mobile', weekday: MOBILE_DAY, durationMin: 90, busy: busyNoon });
const s45 = generateSlots({ location: 'mobile', weekday: MOBILE_DAY, durationMin: 45, busy: busyNoon });
ok('mobile: 90 min cannot start 11:00 (runs into 12:00 booking)', !s90.includes(660));
ok('mobile: 45 min can start 11:00', s45.includes(660));
ok('mobile: 90 min can start 12:30', s90.includes(750));
ok('mobile: last start 20:00 still offered (no closing rule)', s90.includes(1200));
ok('mobile: 10:30 NOT offered for 90 min (90 + 15 runs into 12:00)', !s90.includes(630));
ok('mobile: 10:00 offered for 90 min (ends 11:45 incl. buffer)', s90.includes(600));

// ── Turnaround buffer + durations ─────────────────────────────────────────
console.log('\nTurnaround buffer: a 9:00 clinic booking, then the next slot offered');
eq('TURNAROUND_MIN is 15', TURNAROUND_MIN, 15);
const nextAfter900 = (lenMin) => {
  const blockedUntil = 540 + lenMin + TURNAROUND_MIN;
  const slots = generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: lenMin, busy: [{ s: 540, e: blockedUntil }] });
  return minutesToLabel(slots.find((t) => t > 540));
};
eq('45 min  → next 10:00 am', nextAfter900(45), '10:00 am');
eq('60 min  → next 10:30 am', nextAfter900(60), '10:30 am');
eq('75 min  → next 10:30 am', nextAfter900(75), '10:30 am');
eq('90 min  → next 11:00 am', nextAfter900(90), '11:00 am');
eq('105 min → next 11:00 am', nextAfter900(105), '11:00 am');
eq('Face + Head Massage (120) → next 11:30 am', nextAfter900(two.totalMin), '11:30 am');

console.log('\nTurnaround buffer: applies to the NEW booking too (gap before the next client)');
// Someone is booked 12:00–12:45 (+15 → blocked to 13:00 is stored as e=780; here a block starting 12:00).
const noonBlock = [{ s: 720, e: 780 }];
const s60 = generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: 60, busy: noonBlock });
ok('60 min at 10:45 would not exist on the grid; 10:30 (ends 11:30 + 15 = 11:45) fits', s60.includes(630));
ok('60 min at 11:00 (ends 12:00 + 15 buffer) runs into the 12:00 booking → removed', !s60.includes(660));
ok('45 min at 11:00 (ends 11:45 + 15 = 12:00) fits exactly', generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: 45, busy: noonBlock }).includes(660));

console.log('\nTurnaround buffer vs the Milton Hall closing rule: late clinic starts depend on the treatment; home visits are unaffected');
for (const len of [45, 75, 105, 120]) {
  const fits1930 = len <= 75;   // 19:30 + len + 15 <= 21:00
  ok(`${len} min: 19:30 clinic start ${fits1930 ? 'is offered' : 'is NOT offered (would overrun the 9pm lock-up)'}`, generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: len }).includes(1170) === fits1930);
  ok(`${len} min: 20:00 mobile start still offered on an empty day`, generateSlots({ location: 'mobile', weekday: MOBILE_DAY, durationMin: len }).includes(1200));
}

console.log('\nMilton Hall closing rule (clinic-rules.js: closing 21:00, tidy-up 15 min)');
eq('closing time is 21:00 (1260 min)', CLINIC_RULES.closingMin, 1260);
eq('tidy-up buffer is 15 minutes', CLINIC_RULES.TIDY_UP_MIN, 15);
ok('fits exactly at the boundary: 19:30 + 75 + 15 = 21:00', CLINIC_RULES.fits(1170, 75));
ok('one minute over does not fit', !CLINIC_RULES.fits(1171, 75));
eq('latest start for a 105 min treatment is 19:00', CLINIC_RULES.latestStart(105), 1140);
const lastStart = (d) => Math.max(...generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: d }));
for (const [name, cat] of [['Full Body', 'wet'], ['Head, Scalp & Full Body', 'wet'], ['Face Cupping', 'dry'], ['Full Body Massage', 'massage'], ['Pain & Mobility', 'packages']]) {
  const svc = SERVER_SERVICES[cat].find((x) => x.name === name);
  const slots = generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: svc.min });
  ok(`${name} (${cat}, ${svc.min} min): every offered clinic start finishes by 9pm`, slots.length > 0 && slots.every((t) => t + svc.min + 15 <= 1260));
  ok(`${name} (${cat}, ${svc.min} min): the next half-hour start after the last one offered would overrun (or is past the last grid start)`, !CLINIC_RULES.fits(lastStart(svc.min) + 30, svc.min) || lastStart(svc.min) + 30 > 1170);
}
ok('every treatment in the catalogue has a real duration (none missing)', Object.values(SERVER_SERVICES).every((l) => l.every((x) => Number(x.min) > 0)));
ok('a long multi-treatment cart (195 min) pushes the last clinic start back to 17:30', lastStart(195) === 1050);
ok('slots that would overrun are simply absent (nothing greyed, nothing to explain)', !generateSlots({ location: 'clinic', weekday: CLINIC_DAY, durationMin: 105 }).includes(1170));
ok('home visits ignore the closing rule (a 195 min mobile visit still starts at 20:00)', generateSlots({ location: 'mobile', weekday: MOBILE_DAY, durationMin: 195 }).includes(1200));

console.log('\nCheckout rejects a Milton Hall start that breaks the rule (tampered or stale request)');
globalThis.fetch = async () => { throw new Error('offline (test)'); };   // never reach the network
const checkout = async (time, location = 'clinic') => {
  const res = await createCheckout({ request: new Request('https://x.invalid/create-checkout', { method: 'POST', body: JSON.stringify({ treatments: [{ name: 'Full Body', category: 'wet' }], customerEmail: 'a@example.invalid', customerName: 'Test', customerPhone: '07000000000', date: 'x', time, location, bookingDate: '2099-12-29', travelPostcode: 'M1 1AA', customerAddress: 'x' }) }), env: {} });
  let body = {}; try { body = await res.json(); } catch (e) {}
  return { status: res.status, error: body.error };
};
const bad = await checkout('7:30 pm');
ok('90 min at 19:30 on a Tuesday → 400 slot_invalid', bad.status === 400 && bad.error === 'slot_invalid');
const good = await checkout('7:00 pm');
ok('90 min at 19:00 (finishes by 9pm with tidy-up) is NOT rejected for the rule', good.error !== 'slot_invalid');
const mob = await checkout('7:30 pm', 'mobile');
ok('the same time as a home visit is not rejected for the rule', mob.error !== 'slot_invalid');

console.log('\nDurations: server (_services.js) and browser (services-data.js) agree for EVERY treatment');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../services-data.js', import.meta.url), 'utf8') + ';this.SERVICES = SERVICES;', ctx);
const parseTime = (t) => { const h = /(\d+)\s*(?:hours?|hrs?|hr)\b/i.exec(t), m = /(\d+)\s*min/i.exec(t); return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0) || 60; };
let durationMismatches = 0;
for (const cat of Object.keys(SERVER_SERVICES)) {
  SERVER_SERVICES[cat].forEach((srv, i) => {
    const cli = ctx.SERVICES[cat][i];
    const cliMin = cli.sessionMin || parseTime(cli.time);
    if (cli.name !== srv.name || cliMin !== srv.min) { durationMismatches++; console.error(`     mismatch: ${cat} ${srv.name} client ${cliMin} server ${srv.min}`); }
  });
}
eq('no client/server duration mismatches', durationMismatches, 0);
ok('every package is 90 min on the server', SERVER_SERVICES.packages.every((p) => p.min === 90));

console.log('\nLife coaching: Milton Hall, a home visit or online; one session can be combined with other treatments at the clinic');
const coachingCart = [{ name: 'Life Coaching Session', category: 'coaching' }];
const rc = resolveCart(coachingCart);
ok('single session is the net coaching price and 60 min', rc.ok && rc.totalPence === P('coaching','Life Coaching Session') && rc.totalMin === 60);
const rp = resolveCart([{ name: 'Six-Session Coaching Package', category: 'coaching' }]);
ok('six-session package is the net package price and books a 60 min first session', rp.ok && rp.totalPence === P('coaching','Six-Session Coaching Package') && rp.totalMin === 60);
const rcombo = resolveCart([...coachingCart, { name: 'Full Body', category: 'wet' }]);
ok('a coaching session can be combined with a hijama treatment (price and time add up)', rcombo.ok && rcombo.items.length === 2 && rcombo.totalMin === 60 + rcombo.items[1].min && rcombo.totalPence === P('coaching','Life Coaching Session') + rcombo.items[1].pricePence, rcombo);
eq('the six-session coaching package cannot be combined', resolveCart([{ name: 'Six-Session Coaching Package', category: 'coaching' }, { name: 'Face Massage', category: 'massage' }]).error, 'package_not_combinable');
eq('a coaching session + a treatment package cannot be combined', resolveCart([...coachingCart, { name: 'Cycle Comfort', category: 'packages' }]).error, 'package_not_combinable');
eq('coaching + another treatment is fine on a home visit', cartFitsLocation(rcombo.items, 'mobile'), true);
eq('coaching alone is fine on a home visit', cartFitsLocation(rc.items, 'mobile'), true);
eq('coaching + another treatment is refused online (online is coaching-only)', cartFitsLocation(rcombo.items, 'virtual'), false);
eq('coaching + another treatment is fine at the clinic', cartFitsLocation(rcombo.items, 'clinic'), true);
const coachingCheckout = async (location, time = '7:00 pm') => {
  const res = await createCheckout({ request: new Request('https://x.invalid/create-checkout', { method: 'POST', body: JSON.stringify({ treatments: coachingCart, customerEmail: 'a@example.invalid', customerName: 'Test', customerPhone: '07000000000', date: 'x', time, location, bookingDate: '2099-12-29', travelPostcode: 'M1 1AA', customerAddress: 'x' }) }), env: {} });
  let body = {}; try { body = await res.json(); } catch (e) {}
  return { status: res.status, error: body.error };
};
ok('coaching as a home visit is no longer rejected for location', (await coachingCheckout('mobile')).error !== 'treatment_location_mismatch');
ok('coaching online is not rejected for location or slot (Tuesday 2099-12-29 7pm)', !['treatment_location_mismatch', 'slot_invalid'].includes((await coachingCheckout('virtual')).error));
ok('coaching at the clinic is not rejected for location or slot', !['treatment_location_mismatch', 'slot_invalid'].includes((await coachingCheckout('clinic')).error));
const massageOnline = await createCheckout({ request: new Request('https://x.invalid/create-checkout', { method: 'POST', body: JSON.stringify({ treatments: [{ name: 'Face Massage', category: 'massage' }], customerEmail: 'a@example.invalid', customerName: 'Test', customerPhone: '07000000000', date: 'x', time: '7:00 pm', location: 'virtual', bookingDate: '2099-12-29' }) }), env: {} });
eq('a massage cannot be booked online', (await massageOnline.json()).error, 'treatment_location_mismatch');
ok('online coaching uses the Mon–Sat 10:00–20:00 hours (a Thursday 20:00 start is offered, Sunday has none)', generateSlots({ location: 'mobile', weekday: MOBILE_DAY, durationMin: 60 }).includes(1200) && startGrid('mobile', 0).length === 0);

// Summary
console.log(`\n${pass + fail} tests — ${pass} passed, ${fail} failed${fail ? ' ← FIX BEFORE SHIPPING' : ''}\n`);
if (fail) process.exit(1);
