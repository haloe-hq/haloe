// Run: node website-and-booking/tools/test-schema.mjs
// Guards the structured data on the public pages: every JSON-LD block parses, the homepage service price ranges
// match the real list prices in the catalogue, and name / phone / hours / areas / social profiles agree everywhere.
import fs from 'node:fs';
import { SERVICES } from '../functions/_services.js';
const dir = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const pages = ['index', 'hijama-manchester', 'cupping-manchester', 'massage-manchester', 'life-coaching-manchester', 'about-halima'];
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + extra}`); };
const blocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const walk = (o, f) => { if (Array.isArray(o)) o.forEach((x) => walk(x, f)); else if (o && typeof o === 'object') { f(o); Object.values(o).forEach((x) => walk(x, f)); } };

const seen = { phone: new Set(), hours: new Set(), areas: new Set(), same: new Set() };
for (const p of pages) {
  const html = fs.readFileSync(`${dir}/${p}.html`, 'utf8');
  const bs = blocks(html);
  ok(`${p}: has JSON-LD`, bs.length > 0);
  for (const b of bs) {
    let j; try { j = JSON.parse(b); } catch (e) { ok(`${p}: JSON-LD parses`, false, e.message); continue; }
    walk(j, (o) => {
      if (o.telephone) seen.phone.add(o.telephone);
      if (o.areaServed && Array.isArray(o.areaServed)) seen.areas.add(JSON.stringify(o.areaServed));
      if (o.sameAs) seen.same.add(JSON.stringify(o.sameAs));
      if (o['@type'] === 'OpeningHoursSpecification' && o.dayOfWeek === 'Tuesday') seen.hours.add(`${o.opens}-${o.closes}`);
    });
  }
  ok(`${p}: no room number`, !/room 4/i.test(html));
}
ok('one phone number everywhere', seen.phone.size === 1 && [...seen.phone][0] === '+447474833643', [...seen.phone].join(','));
ok('one Tuesday opening time everywhere', seen.hours.size === 1, [...seen.hours].join(','));
ok('one area list everywhere', seen.areas.size === 1, String(seen.areas.size));
ok('one social profile list everywhere', seen.same.size === 1, String(seen.same.size));

console.log('\nHomepage service prices match the catalogue (list prices)');
const home = blocks(fs.readFileSync(`${dir}/index.html`, 'utf8')).map((b) => JSON.parse(b));
const offers = {}; walk(home, (o) => { if (o['@type'] === 'AggregateOffer') offers[o.itemOffered.name] = o; });
const range = (k) => { const p = SERVICES[k].map((x) => x.price); return [Math.min(...p), Math.max(...p), p.length]; };
for (const [name, key] of [['Massage', 'massage'], ['Dry cupping', 'dry'], ['Hijama (wet cupping)', 'wet'], ['Life coaching', 'coaching']]) {
  const [lo, hi, n] = range(key), o = offers[name];
  ok(`${name}: £${lo}–£${hi} (${n} options)`, o && Number(o.lowPrice) === lo && Number(o.highPrice) === hi && Number(o.offerCount) === n, JSON.stringify(o && [o.lowPrice, o.highPrice, o.offerCount]));
}
console.log('\nllms.txt prices match the catalogue');
const llms = fs.readFileSync(`${dir}/llms.txt`, 'utf8');
for (const [label, key] of [['massage', 'massage'], ['dry cupping', 'dry'], ['hijama', 'wet']]) {
  const [lo, hi] = range(key);
  ok(`llms.txt ${label} £${lo} to £${hi}`, llms.includes(`${label} £${lo} to £${hi}`));
}
ok('llms.txt coaching £50 / £250', llms.includes(`life coaching £${SERVICES.coaching[0].price} for one session or £${SERVICES.coaching[1].price} for six`));
ok('llms.txt names the end of the offer', llms.includes('30 April 2027'));

console.log(`\n${pass + fail} checks — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
