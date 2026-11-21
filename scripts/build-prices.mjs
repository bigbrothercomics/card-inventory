// Downloads the Card Kingdom price list and writes a slim prices.json for the app.
// Usage: node scripts/build-prices.mjs [outFile] [localInputFile]
import { writeFile, readFile } from 'node:fs/promises';

const OUT = process.argv[2] || 'site/prices.json';
const IN = process.argv[3];
const URL = 'https://api.cardkingdom.com/api/v2/pricelist';

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const int = v => parseInt(v, 10) || 0;

let text;
if (IN) text = await readFile(IN, 'utf8');
else {
  const r = await fetch(URL, { headers: { 'User-Agent': 'BigBrotherComics-inventory/1.0' } });
  if (!r.ok) throw new Error('Card Kingdom returned HTTP ' + r.status);
  text = await r.text();
}
const raw = JSON.parse(text);
const rows = raw.data || [];
if (rows.length < 50000) throw new Error('Price list looks too small (' + rows.length + ' listings); not publishing it');

// items[scryfall_id] = { n|f|e: [nmP, exP, vgP, gP, nmQ, exQ, vgQ, gQ, buyP, buyQ, urlPath] }
// finish: n = nonfoil, f = foil, e = etched (CK lists etched as is_foil=false with variation "Foil Etched").
// One listing per printing and finish. When CK has two (usually the original plus a "The List" reprint
// sharing the Scryfall ID), the original set's listing wins.
const isList = c => /the list|mystery booster/i.test(c.edition || '');
const items = {};
let kept = 0, noId = 0;
for (const c of rows) {
  if (!c || !c.scryfall_id) { noId++; continue; }
  const etched = /etched/i.test(c.variation || '');
  const foil = String(c.is_foil).toLowerCase() === 'true';
  const fin = etched ? 'e' : foil ? 'f' : 'n';
  const cv = c.condition_values || {};
  const hasCv = cv.nm_price !== undefined;
  const p = hasCv ? [num(cv.nm_price), num(cv.ex_price), num(cv.vg_price), num(cv.g_price)] : [num(c.price_retail), 0, 0, 0];
  const q = hasCv ? [int(cv.nm_qty), int(cv.ex_qty), int(cv.vg_qty), int(cv.g_qty)] : [int(c.qty_retail), 0, 0, 0];
  const rec = items[c.scryfall_id] ||= {};
  const prev = rec[fin];
  if (prev && !(prev.list && !isList(c))) continue;
  rec[fin] = { list: isList(c), v: [...p, ...q, num(c.price_buy), int(c.qty_buying), String(c.url || '').replace(/^mtg\//, '')] };
  if (!prev) kept++;
}
for (const rec of Object.values(items)) for (const k in rec) rec[k] = rec[k].v;
// mins[folded card name] = the cheapest nonfoil Near Mint retail price among ALL of Card Kingdom's versions of that card
// (every set, showcase, The List…). Only names whose cheapest version is $10 or more are kept; the app tags a card "Case"
// when this is at least $19.99. Names are folded like the app does: no accents or capitals, punctuation becomes a space.
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const mins = {};
const seenMin = {};
for (const c of rows) {
  if (!c || !c.name) continue;
  const foil = String(c.is_foil).toLowerCase() === 'true' || /etched|foil/i.test(c.variation || '');
  if (foil) continue;
  const cv = c.condition_values || {};
  const p = cv.nm_price !== undefined ? num(cv.nm_price) : num(c.price_retail);
  if (!(p > 0)) continue;
  const k = fold(c.name);
  if (seenMin[k] === undefined || p < seenMin[k]) seenMin[k] = p;
}
for (const k in seenMin) if (seenMin[k] >= 10) mins[k] = seenMin[k];
const out = { created: raw.meta?.created_at || '', built: new Date().toISOString(), base: (raw.meta?.base_url || 'https://www.cardkingdom.com/').replace(/\/?$/, '/') + 'mtg/', count: kept, mins, items };
await writeFile(OUT, JSON.stringify(out));
console.log(`Wrote ${OUT}: ${kept} listings for ${Object.keys(items).length} printings (${noId} without a Scryfall ID skipped)`);
