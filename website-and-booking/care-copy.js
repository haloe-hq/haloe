// The "Modesty and care" wording — the ONE place it lives.
//
// A plain classic script (no `export`), same pattern as venue-copy.js / aftercare-copy.js: book.html and intake.html load it with
// <script src="/care-copy.js"> and it defines CARE_COPY on the global object; the Pages Functions import it for its side effect
// (functions/_care-copy.js) so the confirmation email says exactly the same thing. The two FAQ entries (index.html and
// hijama-manchester.html, incl. its FAQPage JSON-LD) are static text for search engines — tools/test-care-copy.mjs fails if any
// of them drifts from `faqQuestion` / `body` below. Change the words here and nowhere else.
(function (g) {
  const body = 'For modesty and professional care, I do not treat the area between the navel and the knees on male clients. That area stays covered throughout the session. Everything else is treated as booked.';
  g.CARE_COPY = {
    heading: 'Modesty and care',
    // Intake form only (6 Nov 2026): everyone sees this neutral line; `body` (the navel-to-knees note) is shown only to clients
    // who say they are male. The site FAQs and the confirmation email keep using `body` / `emailLine` unchanged.
    generalBody: 'Your comfort comes first. Only the area being treated is uncovered, and you can ask me to pause, adjust or stop at any time.',
    body,
    tick: 'I understand and agree',
    emailLine: 'A note on care: for male clients, the area between the navel and the knees is not treated and stays covered.',
    faqQuestion: 'Is any area not treated?',
    faqAnswer: body,
    hint: 'Please tick the box above to continue.',
    // Booking page, under the pay button.
    payHint: 'You will be asked to confirm this on your intake form.',
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
