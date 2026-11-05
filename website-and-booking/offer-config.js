// Site-wide introductory offer — the ONE place to change it.
//
// Every treatment (coaching included) is 20% off automatically, with no code to type, until the end of
// `endsOn` (a UK calendar date, inclusive). After that date siteOfferPercent() returns 0 and every price
// list, struck-through price and charge falls back to the list price on its own.
//
// A discount code never stacks with this offer: the customer gets whichever single discount is larger
// (see priceWithCode() in functions/_discounts.js). Travel is never discounted.
//
// Plain classic script, same pattern as clinic-rules.js: pages load it with <script src="/offer-config.js">
// BEFORE services-data.js, and the Pages Functions import it for its side effect (functions/_services.js).
globalThis.SITE_OFFER = { percent: 20, endsOn: '2027-04-30' };

// Percentage the site-wide offer takes off right now (0 once it has ended). `now` is optional (a Date or ms).
globalThis.siteOfferPercent = function siteOfferPercent(now) {
  const offer = globalThis.SITE_OFFER;
  let today;
  try {
    today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(now == null ? new Date() : new Date(now)); // yyyy-mm-dd
  } catch (e) {
    today = new Date().toISOString().slice(0, 10);
  }
  return today <= offer.endsOn ? offer.percent : 0;
};
