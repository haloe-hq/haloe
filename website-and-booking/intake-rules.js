// Shared intake-form rules — ONE copy, used by the page (intake.html) and the Function (functions/_intake-rules.js).
//
// Plain classic script, same pattern as care-copy.js / clinic-rules.js: browsers load it with
// <script src="/intake-rules.js"> and it defines INTAKE_RULES on the global object; the Pages Function imports it
// for its side effect and reads the same global. So phone, date-of-birth, email, which consents each form needs, and
// the higher-risk flags can never disagree between the page and the server.
(function (g) {
  var CONSENTS_PHYSICAL = ['consent_accurate_info', 'consent_complementary', 'consent_treatment', 'consent_notify_changes', 'consent_data_storage', 'consent_modesty'];

  // key -> { label, consents the server insists on, signature required?, physical (touch) session? }
  var TYPES = {
    hijama:    { label: 'Hijama',                 consents: CONSENTS_PHYSICAL, signature: true,  physical: true },
    dry:       { label: 'Dry cupping',            consents: CONSENTS_PHYSICAL, signature: true,  physical: true },
    massage:   { label: 'Massage',                consents: CONSENTS_PHYSICAL, signature: true,  physical: true },
    coaching:  { label: 'Life coaching',          consents: ['consent_accurate_info', 'consent_complementary', 'consent_data_storage'], signature: true, physical: false },
    notsure:   { label: 'Not sure yet',           consents: ['consent_data_storage'], signature: false, physical: false },
    checkin:   { label: 'Returning client check-in', consents: ['consent_accurate_info'], signature: false, physical: false },
    homevisit: { label: 'Home visit details',     consents: ['consent_data_storage'], signature: false, physical: false }
  };

  function str(v) { return v == null ? '' : String(v).trim(); }

  // ---- Email ----
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
  function validEmail(v) { return EMAIL_RE.test(str(v)); }

  // ---- Phone ----
  // National form of a UK number ("07700 900123", "+44 7700 900123", "0044 (0)7700 900123" -> "07700900123"), or ''.
  function ukNational(v) {
    var s = str(v).replace(/\(0\)/g, '').replace(/[\s\-.()]/g, '');
    if (/^\+44/.test(s)) s = '0' + s.slice(3);
    else if (/^0044/.test(s)) s = '0' + s.slice(4);
    return /^0[1-9]\d{9}$/.test(s) ? s : '';
  }
  function validUkPhone(v) { return !!ukNational(v); }
  // Emergency contacts can live abroad: a UK number, or a +country number of a sane length.
  function validPhoneAny(v) {
    if (validUkPhone(v)) return true;
    var s = str(v).replace(/[\s\-.()]/g, '');
    return /^\+(?!44)\d{8,15}$/.test(s);
  }

  // ---- Date of birth (yyyy-mm-dd, as <input type="date"> gives it) ----
  // -> { ok, reason: 'missing' | 'invalid' | 'future' | 'under18' | 'too_old', age }
  function checkDob(v, now) {
    var s = str(v);
    if (!s) return { ok: false, reason: 'missing' };
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return { ok: false, reason: 'invalid' };
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { ok: false, reason: 'invalid' };
    var n = now ? new Date(now) : new Date();
    var ty = n.getFullYear(), tm = n.getMonth() + 1, td = n.getDate();
    if (y > ty || (y === ty && (mo > tm || (mo === tm && d > td)))) return { ok: false, reason: 'future' };
    var age = ty - y - ((tm < mo || (tm === mo && td < d)) ? 1 : 0);
    if (age < 18) return { ok: false, reason: 'under18', age: age };
    if (age > 120) return { ok: false, reason: 'too_old', age: age };
    return { ok: true, age: age };
  }
  var DOB_MSG = {
    missing: 'Please enter your date of birth.',
    invalid: 'That date doesn’t look right. Please check it.',
    future: 'Your date of birth can’t be in the future.',
    under18: 'You need to be 18 or over to complete this form. Please message Halima.',
    too_old: 'That date doesn’t look right. Please check the year.'
  };

  // ---- Higher-risk answers ----
  // Labels match the practitioner app's "Act on this" list so the two never show the same thing twice.
  var CLOT_RE = /warfarin|apixaban|eliquis|rivaroxaban|xarelto|clopidogrel|plavix|aspirin|tranexamic(?: acid)?|cyklokapron/i;
  function notNo(v) { var s = str(v).toLowerCase(); return !!s && s !== 'no' && s !== 'not applicable'; }
  function riskFlags(row, answers) {
    row = row || {}; answers = answers || {};
    var out = [];
    function add(label) { if (out.indexOf(label) < 0) out.push(label); }
    if (notNo(row.takes_blood_thinners)) add('Takes blood-thinning / anticoagulant medication');
    if (CLOT_RE.test(str(row.current_medications))) add('Medication on the clotting watch-list');
    if (notNo(row.is_pregnant)) add('Pregnant, or a chance she could be');
    if (notNo(row.breastfeeding)) add('Breastfeeding');
    if (notNo(row.diabetes_status)) add('Diabetes');
    if (notNo(row.has_anaemia)) add('Anaemia, low iron, or feels faint or dizzy easily');
    if (notNo(row.bleeding_disorder)) add('Bleeding or clotting disorder');
    if (notNo(row.infectious_condition)) add('Blood-borne infection');
    if (notNo(row.skin_condition)) add('Skin issue, infection or broken skin in the treatment area');
    if (notNo(answers.unwell_today)) add('Unwell or feverish on the day');
    if (notNo(answers.changed)) add('Something has changed since their last visit');
    return out;
  }

  g.INTAKE_RULES = {
    TYPES: TYPES,
    EMAIL_RE: EMAIL_RE,
    CLOT_RE: CLOT_RE,
    validEmail: validEmail,
    ukNational: ukNational,
    validUkPhone: validUkPhone,
    validPhoneAny: validPhoneAny,
    checkDob: checkDob,
    DOB_MSG: DOB_MSG,
    riskFlags: riskFlags
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
