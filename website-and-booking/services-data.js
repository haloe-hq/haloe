// Shared treatment catalogue + live pricing — the single source of truth for
// book.html and hijama-manchester.html, so the two price lists can't silently
// diverge from each other. Loaded via <script src="services-data.js">, since
// this site has no build step or module system; it defines SERVICES,
// PROMO_DISCOUNT and netPrice() as plain globals.
//
// `sessionMin` on a package is the length of ONE session (the first, which
// is what the calendar books). Single treatments get theirs parsed from
// `time`. functions/_services.js mirrors both as `min` — keep in step.
//
// index.html's booking widget keeps its own separate HB_SERVICES /
// HB_PROMO_DISCOUNT copy (see CLAUDE.md) — it predates this file and has its
// own quirks (badges, no desc on non-package items), so it wasn't folded in.
const SERVICES = {
  massage: [
{ name: 'Face Massage', time: '1 hour', price: 40, desc: 'Gentle facial massage to relax and refresh.' },
    { name: 'Head Massage', time: '1 hour', price: 40, desc: 'Soothing scalp and head massage to help you unwind.' },
    { name: 'Face & Head Massage', time: '1 hour', price: 70, desc: 'Face and scalp together, for deeper calm.' },
    { name: 'Head & Foot Massage', time: '1 hr 30 min', price: 60, desc: 'Head and feet, for head-to-toe ease.' },
    { name: 'Foot Massage', time: '45 min', price: 50, desc: 'A slow, grounding massage to ease tired feet and legs.' },
    { name: 'Back, Neck & Shoulders', time: '1 hour', price: 75, desc: 'Eases everyday tension where you hold it most.' },
    { name: 'Full Body Massage', time: '1 hr 30 min', price: 90, desc: 'A slow, head-to-toe reset for tired muscles.' },
  ],
  dry: [
    { name: 'Face Cupping', time: '45 min', price: 50, desc: 'Gentle suction to lift and refresh the skin.' },
    { name: 'Head Cupping', time: '1 hour', price: 50, desc: 'Light cupping across the scalp to help you unwind.' },
    { name: 'Face & Head Cupping', time: '1 hour', price: 85, desc: 'Face and scalp together, for a fuller reset.' },
    { name: 'Targeted Area / Sports Injury', time: '1 hour', price: 60, desc: 'Focused suction on tight, overworked muscles.' },
    { name: 'Full Back', time: '1 hour', price: 80, desc: 'Full-back cupping to release built-up tension.' },
    { name: 'Full Body', time: '1 hr 30 min', price: 100, desc: 'Whole-body cupping for all-over release.' },
    { name: 'Head, Scalp & Full Body', time: '2 hours', price: 115, desc: 'Scalp to sole — the complete dry-cupping session.' },
  ],
  wet: [
    { name: 'Head & Scalp', time: '1 hour', price: 70, desc: 'Traditional hijama (wet cupping) focused on the head and scalp.' },
    { name: 'Targeted Area / Sports Injury', time: '1 hour', price: 80, desc: 'Hijama, or wet cupping, on a specific area of tension.' },
    { name: 'Full Back', time: '1 hour', price: 90, desc: 'Full-back hijama (wet cupping), the most-requested session.' },
    { name: 'Full Body', time: '1 hr 30 min', price: 120, desc: 'Whole-body hijama, or wet cupping, for an all-over reset.' },
    { name: 'Head, Scalp & Full Body', time: '2 hours', price: 150, desc: 'The complete hijama (wet cupping) session, head to toe.' },
  ],
  // Focused sessions (Oct 2026): the seven "What people come to us for" tiles
  // on the homepage, bookable on their own. Clinic or home visit, not online.
  focused: [
    { name: 'Cycle Comfort session', time: '1 hour', price: 90, desc: "Hijama on the lower back, sacrum and abdomen, at a slow pace, for when your cycle feels off." },
    { name: 'Sunnah session', time: '1 hour', price: 80, desc: "Hijama on the Sunnah points of the head and upper back." },
    { name: 'Calm session', time: '1 hour', price: 70, desc: "Dry cupping and a head massage, for when you can't switch off." },
    { name: 'Reset session', time: '1 hr 30 min', price: 120, desc: "Full body hijama, unhurried, for when you want to start again." },
    { name: 'Shoulders and neck session', time: '1 hour', price: 80, desc: "Targeted cupping across the neck, shoulders and upper back." },
    { name: 'Skin session', time: '1 hour', price: 85, desc: "Dry cupping over the face and scalp to lift and refresh dull, tired skin." },
    { name: 'Energy session', time: '1 hour', price: 90, desc: "Full back hijama with the scalp, for when you're always tired." },
  ],
  // Life coaching (Oct 2026): in person at Milton Hall OR online by video —
  // never a home visit. Each is booked on its own (not combinable). Prices and
  // length come from the brand document. The six-session package books its
  // FIRST session (sessionMin) like the cupping packages do.
  coaching: [
    { name: 'Life Coaching Session', time: '1 hour', price: 50, desc: 'A calm one-to-one conversation to help you notice and shift unhelpful thoughts.' },
    { name: 'Six-Session Coaching Package', time: '6 sessions of 1 hour', price: 250, sessionMin: 60, desc: 'Six one-hour sessions, booked one at a time with Halima, at the clinic or online.' },
  ],
  packages: [
    { name: 'Pain & Mobility',     time: '4 sessions of 1 hr 30 min · over 8–12 wks', pkgMeta: '4 sessions · over 8–12 wks',  pkgDur: '1 hr 30 min', price: 340, sessionMin: 90, desc: 'Targeted cupping on areas of tension and restricted movement, over four sessions.' },
    { name: 'Breathe & Reset',     time: '4 sessions of 1 hr 30 min · over 16 wks',   pkgMeta: '4 sessions · over 16 wks',   pkgDur: '1 hr 30 min', price: 340, sessionMin: 90, desc: 'Four sessions on the chest, upper back and shoulders, spaced over the season.' },
    { name: 'Cycle Comfort',       time: '4 sessions of 1 hr 30 min · over ~3 cycles', pkgMeta: '4 sessions · over ~3 cycles', pkgDur: '1 hr 30 min', price: 340, sessionMin: 90, desc: 'Four sessions timed around your cycle — one per month, roughly three cycles.' },
    { name: 'Stress & Sleep',      time: '6 sessions of 1 hr 30 min · over 24 wks',   pkgMeta: '6 sessions · over 24 wks',   pkgDur: '1 hr 30 min', price: 480, sessionMin: 90, desc: 'Six evening-friendly sessions focused on the neck, shoulders and upper back.' },
    { name: 'Headache & Tension',  time: '6 sessions of 1 hr 30 min · over 14 wks',   pkgMeta: '6 sessions · over 14 wks',   pkgDur: '1 hr 30 min', price: 480, sessionMin: 90, desc: 'Six sessions across the head, neck and shoulders.' },
    { name: 'Digestion & Comfort', time: '6 sessions of 1 hr 30 min · over 24 wks',   pkgMeta: '6 sessions · over 24 wks',   pkgDur: '1 hr 30 min', price: 480, sessionMin: 90, desc: 'Six sessions focused on the abdomen and lower back.' },
    { name: 'Circulation & Energy',time: '8 sessions of 1 hr 30 min · over 18 wks',   pkgMeta: '8 sessions · over 18 wks',   pkgDur: '1 hr 30 min', price: 600, sessionMin: 90, desc: 'Eight full-body sessions over eighteen weeks.' },
    { name: "Women's Cycle Care",  time: '8 sessions of 1 hr 30 min · over 16 wks',   pkgMeta: '8 sessions · over 16 wks',   pkgDur: '1 hr 30 min', price: 600, sessionMin: 90, desc: "Eight sessions across the cycle — our most complete women's course." },
  ],
};

/* ---- Site-wide introductory offer ----
   The percentage and its end date (30 April 2027) live in ONE place: offer-config.js, which every page that
   loads this file loads first. After the end date siteOfferPercent() is 0, netPrice() returns the list price and
   every strikethrough disappears on its own. A discount code never stacks with the offer — the customer gets
   the single larger discount (functions/_discounts.js priceWithCode). netPrice() is the amount actually
   displayed and charged — nothing should read svc.price directly for money. */
function netPrice(svc) {
  // Round at the pence level so sub-£1 prices (e.g. the 50p test treatment)
  // are preserved. For whole-pound prices (40, 75, …) the result is identical.
  return Math.round(svc.price * (1 - siteOfferPercent() / 100) * 100) / 100;
}
