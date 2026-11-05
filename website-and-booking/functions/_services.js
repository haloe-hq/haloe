// Server-side mirror of services-data.js — the browser-side pricing source of
// truth for book.html and hijama-manchester.html. Cloudflare Pages Functions
// run as ES modules and can't import a classic global-scope <script> file, so
// this catalogue is kept in step by hand — same pattern as _clinic.js for the
// Weekly Clinic Day constants. Change a price, treatment name or duration?
// Update services-data.js AND this file together.
//
// `min` is the session length in minutes — what a booking blocks in the
// calendar (parsed from services-data.js's `time`; for a package it is the
// length of ONE session — the first one, which is what gets booked). Since
// Sep 2026 create-checkout.js uses THIS figure for the slot hold, never a
// client-supplied duration.
export const SERVICES = {
  massage: [
{ name: 'Face Massage', price: 40, min: 60 },
    { name: 'Head Massage', price: 40, min: 60 },
    { name: 'Face & Head Massage', price: 70, min: 60 },
    { name: 'Head & Foot Massage', price: 60, min: 90 },
    { name: 'Foot Massage', price: 50, min: 45 },
    { name: 'Back, Neck & Shoulders', price: 75, min: 60 },
    { name: 'Full Body Massage', price: 90, min: 90 },
  ],
  dry: [
    { name: 'Face Cupping', price: 50, min: 45 },
    { name: 'Head Cupping', price: 50, min: 60 },
    { name: 'Face & Head Cupping', price: 85, min: 60 },
    { name: 'Targeted Area / Sports Injury', price: 60, min: 60 },
    { name: 'Full Back', price: 80, min: 60 },
    { name: 'Full Body', price: 100, min: 90 },
    { name: 'Head, Scalp & Full Body', price: 115, min: 120 },
  ],
  wet: [
    { name: 'Head & Scalp', price: 70, min: 60 },
    { name: 'Targeted Area / Sports Injury', price: 80, min: 60 },
    { name: 'Full Back', price: 90, min: 60 },
    { name: 'Full Body', price: 120, min: 90 },
    { name: 'Head, Scalp & Full Body', price: 150, min: 120 },
  ],
  focused: [
    { name: 'Cycle Comfort session', price: 90, min: 60 },
    { name: 'Sunnah session', price: 80, min: 60 },
    { name: 'Calm session', price: 70, min: 60 },
    { name: 'Reset session', price: 120, min: 90 },
    { name: 'Shoulders and neck session', price: 80, min: 60 },
    { name: 'Skin session', price: 85, min: 60 },
    { name: 'Energy session', price: 90, min: 60 },
  ],
  coaching: [
    { name: 'Life Coaching Session', price: 50, min: 60 },
    { name: 'Six-Session Coaching Package', price: 250, min: 60 },
  ],
  packages: [
    { name: 'Pain & Mobility', price: 340, min: 90 },
    { name: 'Breathe & Reset', price: 340, min: 90 },
    { name: 'Cycle Comfort', price: 340, min: 90 },
    { name: 'Stress & Sleep', price: 480, min: 90 },
    { name: 'Headache & Tension', price: 480, min: 90 },
    { name: 'Digestion & Comfort', price: 480, min: 90 },
    { name: 'Circulation & Energy', price: 600, min: 90 },
    { name: "Women's Cycle Care", price: 600, min: 90 },
  ],
};

// The site-wide introductory offer (percent + end date) lives in ../offer-config.js, the same file the pages load,
// so the browser and this server can never disagree. A discount code does not stack with it (see priceWithCode()
// in _discounts.js).
import '../offer-config.js';
export const siteOfferPercent = (now) => globalThis.siteOfferPercent(now);

export function listPrice(svc) { return Math.round(svc.price * 100) / 100; }

export function netPrice(svc) {
  // Round at the pence level (see services-data.js for the rationale).
  return Math.round(svc.price * (1 - siteOfferPercent() / 100) * 100) / 100;
}

// Looks a treatment up by its exact display name, scoped to `category` when
// given. Four names are deliberately reused with different prices across dry
// and wet cupping (e.g. "Full Back" is £80 dry, £90 wet) — searching without
// a category silently returns whichever one is defined first in SERVICES
// (dry, since it comes before wet), undercharging every wet booking of a
// shared name. Both callers (create-checkout.js, apply-discount.js) must
// pass the category the client actually picked; when a category is given,
// the search is scoped to it and does NOT fall back to other categories on a
// miss, so a wrong/stale category can't silently resolve to a different
// treatment's price. Category-less lookup (the old behaviour) is kept only
// for callers that genuinely have no category, and callers should migrate
// off it.
export function findService(treatmentName, category) {
  if (category) {
    const list = SERVICES[category];
    if (!list) return null;
    return list.find(s => s.name === treatmentName) || null;
  }
  for (const list of Object.values(SERVICES)) {
    const svc = list.find(s => s.name === treatmentName);
    if (svc) return svc;
  }
  return null;
}

// Multi-treatment bookings (Oct 2026). `items` is [{ name, category }] as sent
// by book.html. Resolves every entry against the catalogue above (never
// trusting a client price or duration) and returns the combined figures:
//   { ok: true, items: [{ name, category, pricePence, min }], totalPence, totalMin }
//   { ok: false, error: 'unknown_treatment' | 'no_treatments' | 'too_many_treatments'
//                     | 'package_not_combinable' }
// The same treatment twice is collapsed to one; a package (a multi-session
// product) must be the only thing in the booking.
export const MAX_TREATMENTS_PER_BOOKING = 6;
// Booked on their own: a multi-session product (every treatment package, and the six-session coaching package).
// A single Life Coaching Session is NOT solo (Oct 2026): at Milton Hall it can be booked together with other
// treatments in one slot. Online it is still coaching-only (see cartFitsLocation).
export const SOLO_CATEGORIES = ['packages'];
export const SOLO_NAMES = ['Six-Session Coaching Package'];
export const isSolo = (x) => SOLO_CATEGORIES.includes(x.category) || SOLO_NAMES.includes(x.name);

export function resolveCart(items) {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'no_treatments' };
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const svc = findService(it && it.name, it && it.category);
    if (!svc) return { ok: false, error: 'unknown_treatment' };
    const key = `${it.category}:${svc.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: svc.name,
      category: it.category,
      listPricePence: Math.round(listPrice(svc) * 100),
      pricePence: Math.round(netPrice(svc) * 100),
      min: Number(svc.min) > 0 ? Number(svc.min) : 60,
    });
  }
  if (out.length > MAX_TREATMENTS_PER_BOOKING) return { ok: false, error: 'too_many_treatments' };
  if (out.length > 1 && out.some(isSolo)) return { ok: false, error: 'package_not_combinable' };
  return {
    ok: true,
    items: out,
    totalPence: out.reduce((n, x) => n + x.pricePence, 0),
    listTotalPence: out.reduce((n, x) => n + x.listPricePence, 0),
    totalMin: out.reduce((n, x) => n + x.min, 0),
  };
}

// Which places a cart may be booked at. Online: coaching only. Milton Hall and home visits: anything, coaching included
// (a coaching session can be added to a home visit, or booked alone at home; the travel fee applies as for any home visit).
export function cartFitsLocation(items, location) {
  const coaching = items.filter(x => x.category === 'coaching').length;
  if (location === 'virtual') return coaching === items.length;
  if (location === 'mobile') return true;
  return location === 'clinic';
}

// 105 -> '1 hr 45 min', 60 -> '1 hour', 45 -> '45 min' (same wording as services-data.js).
export function formatDuration(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h} hr ${m} min`;
  if (h) return h === 1 ? '1 hour' : `${h} hours`;
  return `${m} min`;
}
