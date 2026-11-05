// Audience codes (YASMZEE25, DB25, POD25) must be usable by many different people, but once per email.
// Checks the redemption row reserveDiscountCode() writes for each code type:   node website-and-booking/tools/test-audience-code.mjs
//  * audience: enforce_limits false (the one-use-per-code index ignores it), enforce_customer true (one use per email stays in the DB)
//  * promo (any reusable promotional code): both false — reusable without limit
//  * gift / competition / reward: both true — strictly single use
//  * a database unique violation (23505, the same email twice) is reported as null = "code taken"
import { reserveDiscountCode } from '../functions/_discounts.js';
const R = []; const check = (n, c, x) => R.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + JSON.stringify(x)));
let last, fail23505 = false;
globalThis.fetch = async (url, o = {}) => {
  last = JSON.parse(o.body);
  if (fail23505) return { ok: false, status: 409, json: async () => ({}), text: async () => '{"code":"23505","message":"duplicate key value violates unique constraint"}' };
  return { ok: true, status: 201, json: async () => [{ id: 7 }], text: async () => '[{"id":7}]' };
};
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const now = Math.floor(Date.now() / 1000);
const flags = async (type) => { const id = await reserveDiscountCode(env, { codeId: 1, email: 'A@B.com', discountPence: 500, type }, now); return { id, el: last.enforce_limits, ec: last.enforce_customer, email: last.customer_email }; };

let r = await flags('audience');
check('audience: reserved', r.id === 7, r);
check('audience: not capped per code', r.el === false, r);
check('audience: still once per email', r.ec === true, r);
check('email lower-cased', r.email === 'a@b.com', r);
r = await flags('promo');   check('promo: no limits at all', r.el === false && r.ec === false, r);
for (const t of ['gift', 'competition', 'reward']) { r = await flags(t); check(t + ': strictly single use', r.el === true && r.ec === true, r); }
fail23505 = true;
check('same email twice → null (code taken)', (await reserveDiscountCode(env, { codeId: 1, email: 'a@b.com', discountPence: 500, type: 'audience' }, now)) === null);
console.log(R.join('\n')); console.log(R.filter((x) => x.startsWith('FAIL')).length ? 'FAILED' : 'ALL PASS'); process.exit(R.some((x) => x.startsWith('FAIL')) ? 1 : 0);
