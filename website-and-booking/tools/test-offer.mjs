// Run: node website-and-booking/tools/test-offer.mjs
// The site-wide 20% offer (offer-config.js) and its interaction with discount codes (priceWithCode in _discounts.js).
import { resolveCart, netPrice, listPrice, findService } from '../functions/_services.js';
import { priceWithCode } from '../functions/_discounts.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log('Offer window (UK calendar date, one config value)');
eq('config end date', globalThis.SITE_OFFER.endsOn, '2027-04-30');
eq('20% on 5 Nov 2026', globalThis.siteOfferPercent(new Date('2026-11-05T12:00:00Z')), 20);
eq('20% on the last day, 23:30 UK (BST)', globalThis.siteOfferPercent(new Date('2027-04-30T22:30:00Z')), 20);
eq('0% from 1 May 2027 00:00 UK', globalThis.siteOfferPercent(new Date('2027-04-30T23:00:00Z')), 0);
eq('0% well after', globalThis.siteOfferPercent(new Date('2027-09-01T12:00:00Z')), 0);

console.log('\nPrices (coaching included)');
const coach = findService('Life Coaching Session', 'coaching');
const six = findService('Six-Session Coaching Package', 'coaching');
eq('coaching list £50 / £250', [listPrice(coach), listPrice(six)], [50, 250]);
eq('coaching with 20% off £40 / £200', [netPrice(coach), netPrice(six)], [40, 200]);
eq('Back, Neck & Shoulders still £75 list', listPrice(findService('Back, Neck & Shoulders', 'massage')), 75);

console.log('\nCart carries list and offer totals');
const cart = resolveCart([{ name: 'Full Body Massage', category: 'massage' }]); // list £90
eq('list total', cart.listTotalPence, 9000);
eq('offer total (20% off)', cart.totalPence, 7200);

console.log('\nCodes never stack with the offer (larger single discount wins)');
const c100 = { listTotalPence: 10000, totalPence: 8000 };
const d25 = priceWithCode(c100, 25, false, new Date('2026-11-05T12:00:00Z'));
eq('25% code on £100 list: pays £75, NOT £60 (no stacking)', [d25.usesCode, d25.finalPence], [true, 7500]);
eq('displayed saving is against the £80 offer price', d25.discountPence, 500);
const d10 = priceWithCode(c100, 10, false, new Date('2026-11-05T12:00:00Z'));
eq('10% code does not beat the 20% offer: not used', [d10.usesCode, d10.finalPence, d10.discountPence], [false, 8000, 0]);
const d20 = priceWithCode(c100, 20, false, new Date('2026-11-05T12:00:00Z'));
eq('equal 20% code: not used, offer kept', d20.usesCode, false);
const d50 = priceWithCode(c100, 50, false, new Date('2026-11-05T12:00:00Z'));
eq('50% code: £50', d50.finalPence, 5000);
const d100 = priceWithCode(c100, 100, false, new Date('2026-11-05T12:00:00Z'));
eq('100% code: free', d100.finalPence, 0);
const dw = priceWithCode(c100, 0, true, new Date('2026-11-05T12:00:00Z'));
eq('travel-waiving code with 0% is still usable, keeps offer price', [dw.usesCode, dw.finalPence], [true, 8000]);

console.log('\nAfter the offer ends a code applies to the list price');
const after = priceWithCode({ listTotalPence: 10000, totalPence: 10000 }, 25, false, new Date('2027-06-01T12:00:00Z'));
eq('25% code after 30 Apr 2027: £75', [after.usesCode, after.finalPence], [true, 7500]);
const afterSmall = priceWithCode({ listTotalPence: 10000, totalPence: 10000 }, 10, false, new Date('2027-06-01T12:00:00Z'));
eq('10% code after the offer: £90', afterSmall.finalPence, 9000);

console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
