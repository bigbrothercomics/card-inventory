'use strict';
// Shared by index.html (sales screen: in-stock search, cart, sales) and admin.html (back office: add/edit stock, history, CSV).
const MODE = document.body.dataset.mode === 'admin' ? 'admin' : 'sell';

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const norm = s => fold(s).replace(/[^a-z0-9]+/g, '');
const words = s => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
const money = n => '$' + (Number(n) || 0).toFixed(2);
const CONDS = ['nm', 'ex', 'vg', 'g'];
const CONDLABEL = { nm: 'NM', ex: 'EX', vg: 'VG', g: 'G' };
const FIN = { nonfoil: 'n', foil: 'f', etched: 'e' };
const POLL_MS = 20000;
const SHOW_MAX = 240;   // tiles drawn at once; typing narrows the list
const ls = { get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

/* ---------- state ---------- */
const S = {
  inv: new Map(),      // key -> {key, qty, name, set, setName, cn}
  seq: 0,              // newest change number we've seen from the server
  loaded: false,
  ck: null,            // {base, created, items}
  cond: new Map(),     // tile key -> 'nm'|'ex'|'vg'|'g'
  tiles: new Map(),    // tile key -> {key, meta, finish}
  pending: new Map(),  // tile key -> number of saves in flight
  who: '',
  searchSeq: 0,
  cart: [],            // [{lk, key, id, finish, cond, name, set, setName, cn, price, qty}]
  sales: [],           // finished sales on this computer, newest first
  selling: false,
  active: null,        // cart line (key|cond) whose tile shows − n + instead of "Add to cart"
  normName: new Map(), // card name -> folded name, for fast filtering
};

/* ---------- shared inventory (Google Sheet via Apps Script) ---------- */
async function api(action, data) {
  if (!window.INVENTORY_API) throw new Error('The app is not connected to the inventory sheet yet (config.js)');
  const body = JSON.stringify({ action, code: ls.get('storecode'), ...data });
  let r;
  try { r = await fetch(window.INVENTORY_API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body }); }
  catch (e) { throw new Error('Could not reach the inventory sheet. Check the internet connection'); }
  const j = await r.json().catch(() => ({ ok: false, error: 'The inventory sheet sent a bad reply (HTTP ' + r.status + ')' }));
  if (j.needCode) {
    const c = prompt('Enter the store code to use the inventory:');
    if (c) { ls.set('storecode', c.trim()); return api(action, data); }
  }
  if (!j.ok) throw new Error(j.error || 'Request failed');
  return j;
}

function setSync(text, bad) { const el = $('#sync'); el.textContent = text; el.classList.toggle('bad', !!bad); }

async function loadInventory() {
  setSync('Loading inventory…');
  const j = await api('inventory');
  S.inv.clear();
  for (const [key, qty, name, set, setName, cn] of j.rows) S.inv.set(key, { key, qty, name, set, setName, cn });
  S.seq = j.seq; S.loaded = true;
  setSync('Inventory up to date');
  renderAll();
  renderCart();
}

let polling = false;
async function poll() {
  if (polling || !S.loaded || document.hidden) return;
  polling = true;
  try {
    const j = await api('changes', { since: S.seq });
    if (j.reload) { await loadInventory(); return; }
    applyChanges(j.changes || []);
    S.seq = Math.max(S.seq, j.seq);
    setSync('Inventory up to date');
  } catch (e) { setSync('Not syncing: ' + e.message, true); }
  finally { polling = false; }
}

function applyChanges(list) {
  const touched = new Set();
  for (const c of list) {
    if (c.seq <= S.seq) continue;
    if (S.pending.get(c.key)) continue;     // our own save is still in flight; its reply sets the number
    setLocalQty(c.key, c.qty, c);
    touched.add(c.key);
  }
  if (!touched.size) return;
  touched.forEach(refreshTile);
  if (MODE === 'admin' && currentTab() === 'stock') updateStockCount();
  if (MODE === 'sell') {
    // A card someone else just put in stock isn't on screen yet; redraw the list so it shows up.
    const missing = [...touched].some(k => qtyOf(k) > 0 && !document.querySelector(`#grid .tile[data-key="${CSS.escape(k)}"]`));
    if (missing && currentTab() === 'sell') renderSell();
    if (S.cart.some(l => touched.has(l.key))) renderCart();
  }
}

function setLocalQty(key, qty, info) {
  const cur = S.inv.get(key);
  if (qty > 0) S.inv.set(key, { key, qty, name: info.name || cur?.name || '', set: info.set || cur?.set || '', setName: info.setName || cur?.setName || '', cn: info.cn || cur?.cn || '' });
  else S.inv.delete(key);
}
const qtyOf = key => (S.inv.get(key) || {}).qty || 0;

/* ---------- name matching ---------- */
// Every word typed must appear somewhere in the card name, in any order, ignoring capitals,
// accents and punctuation: "vic riva", "RIVALRY" and "rivalry vic" all find Vicious Rivalry.
function nameOf(e) { let n = S.normName.get(e.name); if (n === undefined) { n = norm(e.name); S.normName.set(e.name, n); } return n; }
function inStockMatching(q) {
  const toks = words(q);
  const list = [];
  for (const e of S.inv.values()) {
    if (e.qty <= 0) continue;
    if (toks.length) { const n = nameOf(e); if (!toks.every(t => n.includes(t))) continue; }
    list.push(e);
  }
  list.sort((a, b) => a.name.localeCompare(b.name) || a.setName.localeCompare(b.setName) || a.key.localeCompare(b.key));
  return list;
}
const stockTile = e => ({ key: e.key, meta: metaFromStock(e), finish: e.key.split('|')[1] });

/* ---------- Scryfall ---------- */
let lastReq = 0;
async function throttle() { const w = lastReq + 110 - Date.now(); if (w > 0) await sleep(w); lastReq = Date.now(); }
const SF_HEADERS = { Accept: 'application/json;q=0.9,*/*;q=0.8' };

async function sfSearch(q, order) {
  let url = 'https://api.scryfall.com/cards/search?q=' + encodeURIComponent(q) + '&unique=prints&order=' + order + '&include_variations=true';
  const out = []; let pages = 0;
  while (url && pages < 5) {
    await throttle();
    const r = await fetch(url, { headers: SF_HEADERS });
    if (r.status === 404) return { cards: out, more: false };
    if (!r.ok) throw new Error('Scryfall returned ' + r.status);
    const j = await r.json();
    out.push(...j.data);
    url = j.has_more ? j.next_page : null; pages++;
  }
  return { cards: out, more: !!url };
}

// Scryfall serves every card's front image at a predictable address, so stock rows don't need to store it.
const imgFor = id => `https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`;

function metaFromCard(c) {
  const iu = c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) || {};
  return { id: c.id, name: c.name, set: c.set, setName: c.set_name, cn: c.collector_number, released: c.released_at || '', img: iu.normal || iu.small || imgFor(c.id), tcg: (c.purchase_uris && c.purchase_uris.tcgplayer) || '' };
}
function metaFromStock(e) {
  const id = e.key.split('|')[0];
  return { id, name: e.name, set: e.set, setName: e.setName, cn: e.cn, released: '', img: imgFor(id), tcg: '' };
}

/* ---------- Card Kingdom prices (prices.json, rebuilt every 6 hours) ---------- */
async function loadPrices() {
  try {
    const r = await fetch('prices.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    S.ck = await r.json();
    const when = S.ck.created ? new Date(S.ck.created.replace(' ', 'T')).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '?';
    $('#cksummary').textContent = `Card Kingdom prices from ${when}, ${Number(S.ck.count).toLocaleString()} listings.`;
    renderAll();
  } catch (e) {
    $('#cksummary').innerHTML = '<span class="err">Card Kingdom prices could not be loaded (' + esc(e.message) + '). Every card will show "Check TCG" until they load.</span>';
  }
}

// Match by Scryfall ID and finish only. A printing Card Kingdom doesn't list shows "Check TCG" rather than a wrong price.
function ckMatch(meta, finish) {
  const rec = S.ck && S.ck.items[meta.id];
  const v = rec && rec[FIN[finish]];
  if (!v) return null;
  return { p: v.slice(0, 4), q: v.slice(4, 8), buy: v[8], buyQty: v[9], url: v[10] ? S.ck.base + v[10] : '', instock: v.slice(4, 8).some(x => x > 0) };
}

/* ---------- tiles ---------- */
const tcgUrl = meta => meta.tcg || ('https://www.tcgplayer.com/search/magic/product?q=' + encodeURIComponent(meta.name) + '&view=grid');

function priceHTML(t) {
  const { meta, finish, key } = t;
  const link = (title, sub) => `<div class="price tcg"><div class="amt"><a href="${esc(tcgUrl(meta))}" target="_blank" rel="noopener" title="${esc(title)}">Check TCG ↗</a></div>${sub ? `<div class="hint">${esc(sub)}</div>` : ''}</div>`;
  if (!S.ck) return link('Card Kingdom prices are not loaded', 'CK prices not loaded');
  const m = ckMatch(meta, finish);
  if (!m) return link('Not found on Card Kingdom', '');
  if (!m.instock) return link('Out of stock on Card Kingdom', '');
  const cond = S.cond.get(key) || 'nm';
  const p = m.p[CONDS.indexOf(cond)];
  const amt = p > 0 ? '$' + p.toFixed(2) : '—';
  return `<div class="price">
    <div class="amt">${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${amt}</a>` : amt}</div>
    <div class="conds">${CONDS.map(c => `<button data-act="cond" data-c="${c}" class="${c === cond ? 'on' : ''}">${CONDLABEL[c]}</button>`).join('')}</div>
  </div>`;
}

// Sales-screen tiles (cartMode) only sell: "Add to cart". Back-office tiles change the stock count with + / −.
function tileHTML(t, cartMode) {
  const { key, meta, finish } = t;
  const qty = qtyOf(key);
  const busy = S.pending.get(key) ? ' busy' : '';
  const badge = finish === 'foil' ? '<span class="badge">Foil</span>' : finish === 'etched' ? '<span class="badge etched">Etched</span>' : '';
  let controls;
  if (cartMode) {
    const inCart = cartCount(key);
    const full = inCart >= qty;
    const lk = key + '|' + (S.cond.get(key) || 'nm');
    const line = S.active === lk && S.cart.find(l => l.lk === lk);
    // The card just added shows − n + for its cart line until a condition changes or another card is added.
    const action = line
      ? `<div class="qty cartstep"><button data-act="cdec" aria-label="One fewer in the order">−</button><span class="n">${line.qty}</span><button data-act="cinc" aria-label="One more in the order" ${full ? 'disabled' : ''}>+</button><span class="muted">in order</span></div>`
      : `<button class="primary addcart" data-act="cart" ${full ? 'disabled' : ''}>${full ? 'All in order' : 'Add to order'}</button>`;
    controls = qty
      ? `<div class="stockline">${qty} in stock${inCart ? ` · <span class="incart">${inCart} in order</span>` : ''}</div>${action}`
      : `<div class="oostag">Sold out${inCart ? ` · ${inCart} in order` : ''}</div>`;
  } else {
    controls = `${qty ? '' : '<div class="oostag">Out of stock</div>'}
      <div class="qty"><button data-act="dec" aria-label="Remove one" ${qty ? '' : 'disabled'}>−</button><span class="n">${qty}</span><button data-act="inc" aria-label="Add one">+</button></div>`;
  }
  return `<div class="tile ${qty ? '' : 'oos'}${busy}" data-key="${esc(key)}">
    <div class="imgwrap"><img loading="lazy" src="${esc(meta.img)}" alt="${esc(meta.name)}">${badge}</div>
    <div class="info">
      <div class="name">${esc(meta.name)}</div>
      <div class="sub">${esc(meta.setName)} · #${esc(meta.cn)}</div>
      ${priceHTML(t)}
      <div class="ctrls">${controls}</div>
    </div>
  </div>`;
}

function renderGrid(container, tiles) {
  tiles.forEach(t => S.tiles.set(t.key, t));
  const cartMode = container.hasAttribute('data-cart');
  container.innerHTML = tiles.map(t => tileHTML(t, cartMode)).join('');
}

function refreshTile(key) {
  const t = S.tiles.get(key); if (!t) return;
  document.querySelectorAll(`.tile[data-key="${CSS.escape(key)}"]`).forEach(node => {
    const tmp = document.createElement('div'); tmp.innerHTML = tileHTML(t, !!node.closest('[data-cart]'));
    node.replaceWith(tmp.firstElementChild);
  });
}

function onTileClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const key = b.closest('.tile').dataset.key;
  const act = b.dataset.act;
  if (act === 'cart') addToCart(key);
  else if (act === 'cinc' || act === 'cdec') cartAct(S.active, act === 'cinc' ? 'inc' : 'dec');
  else if (act === 'inc') changeQty(key, 1);
  else if (act === 'dec') changeQty(key, -1);
  else if (act === 'cond') {
    S.cond.set(key, b.dataset.c);
    if (S.active && S.active.startsWith(key + '|')) S.active = null;   // new condition: back to "Add to cart"
    refreshTile(key);
  }
}

/* ---------- tabs ---------- */
const VIEWS = { sell: ['sell', 'sales'], admin: ['add', 'stock', 'missing', 'history'] }[MODE];
function setTab(tab) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  VIEWS.forEach(t => { $('#v-' + t).hidden = t !== tab; });
  renderAll();
  if (tab === 'history') renderHistory();
  if (tab === 'missing') loadMissing();
}
function currentTab() { return (document.querySelector('.tabs button.on') || {}).dataset.tab; }
function renderAll() {
  const t = currentTab();
  if (t === 'sell') renderSell();
  else if (t === 'sales') renderSales();
  else if (t === 'add') renderSearch();
  else if (t === 'stock') renderStock();
  else if (t === 'missing') renderMissing();
}

/* =====================================================================
   SALES SCREEN (index.html)
   ===================================================================== */
function renderSell() {
  const note = $('#sellnote'), grid = $('#grid');
  const q = $('#q').value.trim();
  if (!S.loaded) { note.textContent = 'Loading inventory…'; return; }
  const list = inStockMatching(q);
  renderGrid(grid, list.slice(0, SHOW_MAX).map(stockTile));
  const cards = list.reduce((n, e) => n + e.qty, 0);
  if (!list.length) note.textContent = q ? `Nothing in stock matches "${q}".` : 'Nothing in stock yet.';
  else note.textContent = `${q ? 'Matching' : 'In stock'}: ${list.length.toLocaleString()} version${list.length === 1 ? '' : 's'}, ${cards.toLocaleString()} card${cards === 1 ? '' : 's'}.` +
    (list.length > SHOW_MAX ? ` Showing the first ${SHOW_MAX}. Type more of the name to narrow it down.` : '');
}

/* ---------- cart ---------- */
const cartCount = key => S.cart.reduce((n, l) => n + (l.key === key ? l.qty : 0), 0);
const lineTotal = l => (l.price || 0) * l.qty;
const cartTotal = () => S.cart.reduce((n, l) => n + lineTotal(l), 0);
const finLabel = f => (f === 'foil' ? ' (Foil)' : f === 'etched' ? ' (Etched)' : '');
function saveCart() { ls.set('cart', JSON.stringify(S.cart)); }
function saveSales() { ls.set('sales', JSON.stringify(S.sales.slice(0, 200))); }

// The Card Kingdom price for this printing in the chosen condition, or null when there isn't one.
function priceFor(t, cond) {
  const m = S.ck && ckMatch(t.meta, t.finish);
  if (!m || !m.instock) return null;
  const p = m.p[CONDS.indexOf(cond)];
  return p > 0 ? p : null;
}

function addToCart(key) {
  const t = S.tiles.get(key); if (!t) return;
  const stock = qtyOf(key);
  if (cartCount(key) >= stock) { toast(`All ${stock} in stock are already in the order`); return; }
  const cond = S.cond.get(key) || 'nm';
  const lk = key + '|' + cond;
  if (!S.cart.length) ls.set('showlast', '0');   // a new cart begins: retire the last receipt (it stays on the Sales tab)
  let line = S.cart.find(l => l.lk === lk);
  if (line) line.qty++;
  else S.cart.push(line = { lk, key, id: t.meta.id, finish: t.finish, cond, name: t.meta.name, set: t.meta.set, setName: t.meta.setName, cn: t.meta.cn, price: priceFor(t, cond), qty: 1 });
  const prev = S.active && S.active.split('|').slice(0, 2).join('|');
  S.active = lk;
  saveCart(); renderCart(); refreshTile(key);
  if (prev && prev !== key) refreshTile(prev);   // the previous card goes back to "Add to cart"
  if (line.price == null) toast(`${t.meta.name} has no Card Kingdom price. Type a price in the current order.`);
}

function cartAct(lk, act) {
  const i = S.cart.findIndex(l => l.lk === lk); if (i < 0) return;
  const l = S.cart[i];
  if (act === 'inc') { if (cartCount(l.key) >= qtyOf(l.key)) { toast(`Only ${qtyOf(l.key)} in stock`); return; } l.qty++; }
  else if (act === 'dec') { l.qty--; if (l.qty <= 0) S.cart.splice(i, 1); }
  else if (act === 'rm') S.cart.splice(i, 1);
  if (S.active === lk && !S.cart.some(x => x.lk === lk)) S.active = null;
  saveCart(); renderCart(); refreshTile(l.key);
}

function renderCart() {
  const box = $('#cart'); if (!box) return;
  const n = S.cart.reduce((a, l) => a + l.qty, 0);
  let h = `<h2><span>Current order${n ? ` · ${n} card${n === 1 ? '' : 's'}` : ''}</span>${S.cart.length ? '<button data-cact="clear" title="Empty the current order without changing inventory">Clear</button>' : ''}</h2>`;
  if (!S.cart.length) h += '<p class="muted" style="margin:4px 0 8px">Empty. Find a card and press Add to order.</p>';
  for (const l of S.cart) {
    const stock = qtyOf(l.key);
    h += `<div class="cline" data-lk="${esc(l.lk)}">
      <div class="top"><div><div class="name">${esc(l.name)}${finLabel(l.finish)}</div><div class="sub">${esc(l.setName)} · #${esc(l.cn)} · ${CONDLABEL[l.cond]}</div></div>
        <button class="rm" data-cact="rm" title="Remove from order" aria-label="Remove from order">×</button></div>
      <div class="ctl"><button data-cact="dec" aria-label="One fewer">−</button><span class="n">${l.qty}</span><button data-cact="inc" aria-label="One more">+</button>
        <span class="muted">×</span> $<input class="pr" type="text" inputmode="decimal" value="${l.price == null ? '' : l.price.toFixed(2)}" placeholder="price" aria-label="Price each">
        <span class="lt">${money(lineTotal(l))}</span></div>
      ${l.price == null ? '<div class="warn">No Card Kingdom price. Type one in.</div>' : ''}
      ${S.loaded && l.qty > stock ? `<div class="warn">Only ${stock} in stock now</div>` : ''}
    </div>`;
  }
  h += `<div class="total"><span>Total</span><span id="carttotal">${money(cartTotal())}</span></div>`;
  h += `<button class="primary sell" data-cact="sell" ${S.cart.length && !S.selling ? '' : 'disabled'}>${S.selling ? 'Saving order…' : 'Complete order'}</button>`;
  // The last sale's receipt stays under the cart until the next customer's first card goes in.
  if (S.sales.length && !S.cart.length && ls.get('showlast') !== '0') h += receiptHTML(S.sales[0], true);
  box.innerHTML = h;
}

function receiptHTML(s, isLast) {
  const when = new Date(s.time).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const items = s.lines.map(l => `<li><span>${l.sold} × ${esc(l.name)}${finLabel(l.finish)} <span class="muted">${esc(String(l.set || '').toUpperCase())} #${esc(l.cn)} ${CONDLABEL[l.cond]}</span>${l.sold < l.qty ? `<br><span class="short">Only ${l.sold} of ${l.qty} were in stock</span>` : ''}</span><span>${money(l.price * l.sold)}</span></li>`).join('');
  return `<div class="receipt"${isLast ? ' aria-live="polite"' : ''}>
    <div class="rorder">Order #${esc(s.order)}${isLast ? ' <span class="muted">completed</span>' : ''}</div>
    <div class="rhead">${esc(when)} · ${esc(s.who)}</div>
    <div class="rtotal">${money(s.total)}</div><ul>${items}</ul>
    <div class="rhead" style="margin-top:6px">${s.count} card${s.count === 1 ? '' : 's'} removed from inventory</div>
    ${isLast ? '<div class="more"><a data-cact="sales">See all sales</a></div>' : ''}
  </div>`;
}

// The order number (1, 2, 3...) is handed out by the inventory sheet when the order completes,
// so every computer shares one sequence with no repeats.
async function completeSale() {
  if (S.selling || !S.cart.length) return;
  if (!S.who) { toast('Enter your name (top right) first so the order is logged'); $('#who').focus(); return; }
  if (!S.loaded) { toast('The inventory has not loaded yet'); return; }
  const missing = S.cart.find(l => l.price == null);
  if (missing) { toast(`Type a price for ${missing.name} first`); const el = document.querySelector(`.cline[data-lk="${CSS.escape(missing.lk)}"] input.pr`); if (el) el.focus(); return; }
  const cart = S.cart.map(l => ({ ...l }));
  S.selling = true; renderCart();
  let j;
  try {
    j = await api('sell', { who: S.who, rows: cart.map(l => ({ id: l.id, finish: l.finish, qty: l.qty, meta: { name: l.name, set: l.set, setName: l.setName, cn: l.cn } })) });
  } catch (e) {
    S.selling = false; renderCart();
    toast('Order NOT saved: ' + e.message.replace(/\.$/, '') + '. Nothing was removed from inventory. Check History before trying again.');
    return;
  }
  // Share what the server actually removed across this card's cart lines, in cart order.
  const left = new Map(j.items.map(it => [it.key, it.sold]));
  const lines = cart.map(l => { const s = Math.min(l.qty, left.get(l.key) || 0); left.set(l.key, (left.get(l.key) || 0) - s); return { ...l, sold: s }; });
  for (const it of j.items) {
    const l = cart.find(x => x.key === it.key);
    setLocalQty(it.key, it.qty, { name: l.name, set: l.set, setName: l.setName, cn: l.cn });
  }
  const order = j.order != null ? j.order : '?';
  const sale = { order, time: new Date().toISOString(), who: S.who, lines, total: lines.reduce((n, l) => n + l.price * l.sold, 0), count: lines.reduce((n, l) => n + l.sold, 0) };
  S.sales.unshift(sale); saveSales();
  ls.set('showlast', '1');
  S.cart = []; saveCart(); S.active = null;
  S.selling = false;
  renderCart();
  cart.forEach(l => refreshTile(l.key));
  const short = lines.some(l => l.sold < l.qty);
  toast(`Order #${order} complete: ${money(sale.total)}${short ? '. Some cards were no longer in stock, see the receipt.' : ''}`);
}

function onCartClick(e) {
  const b = e.target.closest('[data-cact]'); if (!b) return;
  const act = b.dataset.cact;
  if (act === 'sell') return completeSale();
  if (act === 'sales') return setTab('sales');
  if (act === 'clear') {
    if (!confirm('Clear the current order? Nothing is removed from inventory.')) return;
    const keys = S.cart.map(l => l.key); S.cart = []; S.active = null; saveCart(); renderCart(); keys.forEach(refreshTile); return;
  }
  cartAct(b.closest('.cline').dataset.lk, act);
}
function onCartInput(e) {
  if (!e.target.matches('input.pr')) return;
  const row = e.target.closest('.cline');
  const l = S.cart.find(x => x.lk === row.dataset.lk); if (!l) return;
  const v = parseFloat(e.target.value.replace(/[$,\s]/g, ''));
  l.price = Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  saveCart();
  row.querySelector('.lt').textContent = money(lineTotal(l));
  $('#carttotal').textContent = money(cartTotal());
}

/* ---------- sales tab ---------- */
function renderSales() {
  const sum = $('#salesum'), list = $('#saleslist');
  if (!S.sales.length) { sum.innerHTML = ''; list.innerHTML = '<p class="muted">No sales on this computer yet.</p>'; return; }
  const today = new Date().toDateString();
  const todays = S.sales.filter(s => new Date(s.time).toDateString() === today);
  sum.innerHTML = `<span>Today on this computer: <b>${money(todays.reduce((n, s) => n + s.total, 0))}</b></span>
    <span class="muted">${todays.length} sale${todays.length === 1 ? '' : 's'}, ${todays.reduce((n, s) => n + s.count, 0)} cards</span>
    <span class="muted">Newest first. Kept on this computer only (last 200 sales).</span>`;
  list.innerHTML = S.sales.map(s => receiptHTML(s, false)).join('');
}

/* =====================================================================
   BACK OFFICE (admin.html)
   ===================================================================== */
// The number changes on screen immediately; the save runs in the background and the server's answer is final.
async function changeQty(key, delta) {
  if (!S.who) { toast('Enter your name (top right) first so changes are logged'); $('#who').focus(); return; }
  if (!S.loaded) { toast('The inventory has not loaded yet'); return; }
  const t = S.tiles.get(key); if (!t) return;
  const before = qtyOf(key);
  const after = Math.max(0, before + delta);
  if (after === before) return;
  const info = { name: t.meta.name, set: t.meta.set, setName: t.meta.setName, cn: t.meta.cn };
  setLocalQty(key, after, info);
  S.pending.set(key, (S.pending.get(key) || 0) + 1);
  refreshTile(key); updateStockCount();
  try {
    const j = await api('adjust', { id: t.meta.id, finish: t.finish, delta, who: S.who, meta: info });
    if (S.pending.get(key) === 1) setLocalQty(key, j.qty, info);   // last save for this card: take the server's count
  } catch (e) {
    setLocalQty(key, Math.max(0, qtyOf(key) - delta), info);
    toast('Not saved: ' + e.message);
  } finally {
    const n = S.pending.get(key) - 1; if (n > 0) S.pending.set(key, n); else S.pending.delete(key);
    refreshTile(key); updateStockCount();
  }
}

async function doSearch() {
  const term = $('#aq').value.trim();
  const note = $('#searchnote'), grid = $('#agrid');
  if (!term) { grid.innerHTML = ''; return; }
  const seq = ++S.searchSeq;
  note.textContent = 'Searching…'; note.classList.remove('err');
  try {
    const clean = term.replace(/"/g, '');
    let res = await sfSearch(`!"${clean}" game:paper`, 'released');
    const exact = res.cards.length > 0;
    // Not an exact name: every word must appear in the name ("vic riva" finds Vicious Rivalry).
    if (!exact) res = await sfSearch(`${words(clean).map(w => 'name:' + w).join(' ')} game:paper`, 'name');
    if (seq !== S.searchSeq) return;
    S.lastCards = res.cards; S.lastExact = exact; S.lastMore = res.more; S.lastTerm = term;
    renderSearch();
  } catch (e) {
    if (seq !== S.searchSeq) return;
    note.textContent = 'Search failed: ' + e.message + '. Check your internet connection and try again.';
    note.classList.add('err');
  }
}

function renderSearch() {
  const note = $('#searchnote'), grid = $('#agrid');
  const cards = S.lastCards || [];
  if (!cards.length) { grid.innerHTML = ''; if (S.lastTerm) note.textContent = `No cards found for "${S.lastTerm}".`; return; }
  const showOOS = $('#oos').checked;
  const all = [];
  for (const c of cards) {
    const meta = metaFromCard(c);
    for (const f of (c.finishes && c.finishes.length ? c.finishes : ['nonfoil'])) if (FIN[f]) all.push({ key: meta.id + '|' + f, meta, finish: f });
  }
  const tiles = showOOS ? all : all.filter(t => qtyOf(t.key) > 0);
  renderGrid(grid, tiles);
  const inStock = all.filter(t => qtyOf(t.key) > 0).length;
  const names = new Set(cards.map(c => c.name)).size;
  let msg = S.lastExact ? `Printings of ${cards[0].name}: ` : `${names} card name${names === 1 ? '' : 's'} match "${S.lastTerm}": `;
  msg += `${all.length} versions on Scryfall, ${inStock} in stock.`;
  if (!showOOS && !tiles.length) msg += ' Tick "Show out of stock" to see all versions and add stock.';
  if (S.lastMore) msg += ' Showing the first results only, so try a more specific name.';
  note.textContent = msg;
}

function updateStockCount() {
  if (MODE !== 'admin' || currentTab() !== 'stock') return;
  const list = inStockMatching($('#sq').value);
  $('#stockcount').textContent = `${list.length.toLocaleString()} versions, ${list.reduce((n, e) => n + e.qty, 0).toLocaleString()} cards`;
}
function renderStock() {
  const list = inStockMatching($('#sq').value);
  updateStockCount();
  $('#stocknote').textContent = !S.loaded ? 'Loading inventory…' : list.length ? (list.length > 300 ? 'Showing the first 300. Use the filter to narrow down.' : '') : ($('#sq').value ? 'Nothing in stock matches that filter.' : 'Nothing in stock yet. Use Add stock to search a card and press +.');
  renderGrid($('#stockgrid'), list.slice(0, 300).map(stockTile));
}

async function renderHistory() {
  $('#hist').innerHTML = '<p class="muted">Loading…</p>';
  let rows;
  try { rows = (await api('history', { limit: 300 })).entries; }
  catch (e) { $('#hist').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (!rows.length) { $('#hist').innerHTML = '<p class="muted">No changes yet.</p>'; return; }
  const when = s => new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const chg = n => (n > 0 ? '+' : '') + n;
  $('#hist').innerHTML = '<table><thead><tr><th>When</th><th>Who</th><th>Change</th><th>Card</th><th>Finish</th><th>Now in stock</th></tr></thead><tbody>' +
    rows.map(r => `<tr><td>${esc(when(r.time))}</td><td>${esc(r.who)}</td><td>${esc(r.action)} (${esc(chg(r.change))})</td><td>${esc(r.name)}${r.setName ? ' <span class="muted">(' + esc(r.setName) + (r.cn ? ' #' + esc(r.cn) : '') + ')</span>' : ''}</td><td>${esc(r.finish)}</td><td>${esc(r.qty)}</td></tr>`).join('') + '</tbody></table>';
}

/* ---------- missing cards ---------- */
// One entry per card (oracle id), shown as its original printing. The Scryfall extension adds to the same list.
async function originalPrinting(oracle) {
  for (const q of [`oracleid:${oracle} game:paper -is:promo`, `oracleid:${oracle}`]) {
    const r = await sfSearch(q + '', 'released&dir=asc');
    if (r.cards.length) return r.cards[0];
  }
  throw new Error('Scryfall has no printing for that card');
}

async function loadMissing() {
  if (S.missingBusy) return;
  S.missingBusy = true;
  try { S.missing = (await api('missing')).cards; renderMissing(); }
  catch (e) { $('#missnote').textContent = 'Could not load Missing Cards: ' + e.message; $('#missnote').classList.add('err'); }
  finally { S.missingBusy = false; }
}

// Copies in stock of any printing with this exact card name.
function stockByName() {
  const m = new Map();
  for (const e of S.inv.values()) if (e.qty > 0) m.set(e.name, (m.get(e.name) || 0) + e.qty);
  return m;
}

function renderMissing() {
  const grid = $('#missgrid'), note = $('#missnote');
  if (!S.missing) { note.textContent = 'Loading…'; return; }
  note.classList.remove('err');
  const toks = words($('#mf').value);
  const have = stockByName();
  const list = S.missing.filter(c => !toks.length || toks.every(t => norm(c.name).includes(t))).sort((a, b) => a.name.localeCompare(b.name));
  const nowIn = S.missing.filter(c => have.get(c.name)).length;
  note.textContent = `${S.missing.length.toLocaleString()} card${S.missing.length === 1 ? '' : 's'} on the list` +
    (nowIn ? `, ${nowIn} now in stock (marked green; remove them when you're sure).` : '.') +
    (toks.length ? ` ${list.length} match the filter.` : '');
  grid.innerHTML = list.slice(0, 400).map(c => {
    const q = have.get(c.name) || 0;
    const when = c.added ? new Date(c.added).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    return `<div class="tile" data-oracle="${esc(c.oracle)}">
      <div class="imgwrap"><img loading="lazy" src="${esc(imgFor(c.id))}" alt="${esc(c.name)}"></div>
      <div class="info">
        <div class="name">${esc(c.name)}</div>
        <div class="sub">${esc(c.setName)} · #${esc(c.cn)}</div>
        <div class="sub">Added ${esc(when)}${c.who ? ' by ' + esc(c.who) : ''}</div>
        <div class="ctrls">${q ? `<div class="instock-now">In stock now: ${q}</div>` : ''}
          <button data-mact="rm">Remove from missing</button></div>
      </div></div>`;
  }).join('');
}

async function addMissingByName() {
  const name = $('#mq').value.trim();
  if (!name) return;
  if (!S.who) { toast('Enter your name (top right) first'); $('#who').focus(); return; }
  $('#madd').disabled = true;
  try {
    await throttle();
    const r = await fetch('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(name), { headers: SF_HEADERS });
    if (!r.ok) throw new Error(r.status === 404 ? `Scryfall found no card called "${name}"` : 'Scryfall returned ' + r.status);
    const card = await r.json();
    const orig = await originalPrinting(card.oracle_id || (card.card_faces && card.card_faces[0].oracle_id));
    const j = await api('missingAdd', { who: S.who, oracle: orig.oracle_id || card.oracle_id, id: orig.id, name: orig.name, set: orig.set, setName: orig.set_name, cn: orig.collector_number });
    toast(j.already ? `${card.name} is already on Missing Cards` : `Added ${card.name} (${orig.set_name}) to Missing Cards`);
    $('#mq').value = '';
    await loadMissing();
  } catch (e) { toast('Not added: ' + e.message); }
  finally { $('#madd').disabled = false; }
}

async function onMissingClick(e) {
  const b = e.target.closest('[data-mact]'); if (!b) return;
  const tile = b.closest('.tile'), oracle = tile.dataset.oracle;
  const c = (S.missing || []).find(x => x.oracle === oracle);
  b.disabled = true;
  try {
    await api('missingRemove', { oracle, who: S.who });
    S.missing = S.missing.filter(x => x.oracle !== oracle);
    renderMissing();
    toast(`Removed ${c ? c.name : 'card'} from Missing Cards`);
  } catch (x) { b.disabled = false; toast('Not removed: ' + x.message); }
}

/* ---------- CSV ---------- */
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; rows.push(row); row = []; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}
const csvEsc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';

function exportCSV() {
  const head = ['scryfall_id', 'finish', 'qty', 'name', 'set', 'set_name', 'collector_number'];
  const lines = [head.join(',')];
  [...S.inv.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
    const [id, finish] = e.key.split('|');
    lines.push([id, finish, e.qty, e.name, e.set, e.setName, e.cn].map(csvEsc).join(','));
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = 'inventory-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  toast('Exported ' + S.inv.size.toLocaleString() + ' rows');
}

async function importCSV(text, fileName) {
  if (!S.who) { toast('Enter your name (top right) first so the import is logged'); $('#who').focus(); return; }
  const rows = parseCSV(text); if (rows.length < 2) throw new Error('The file is empty');
  const h = rows[0].map(x => x.trim().toLowerCase());
  const ix = n => h.indexOf(n);
  if (ix('scryfall_id') < 0 || ix('finish') < 0 || ix('qty') < 0) throw new Error('Needs columns: scryfall_id, finish, qty');
  const g = (r, n) => (ix(n) >= 0 ? (r[ix(n)] || '').trim() : '');
  const list = [];
  for (const r of rows.slice(1)) {
    const id = g(r, 'scryfall_id').toLowerCase(), finish = (g(r, 'finish') || 'nonfoil').toLowerCase(), qty = parseInt(g(r, 'qty'), 10);
    if (!/^[0-9a-f-]{36}$/.test(id) || !FIN[finish] || !Number.isFinite(qty) || qty < 0) continue;
    list.push({ id, finish, qty, meta: { name: g(r, 'name'), set: g(r, 'set'), setName: g(r, 'set_name'), cn: g(r, 'collector_number') } });
  }
  if (!list.length) throw new Error('No usable rows');
  if (!confirm(`Set the stock count for ${list.length.toLocaleString()} printings from ${fileName}? This overwrites their current counts.`)) return;
  let changed = 0;
  for (let i = 0; i < list.length; i += 2000) {
    toast(`Importing… ${Math.min(i + 2000, list.length).toLocaleString()} of ${list.length.toLocaleString()}`);
    changed += (await api('setMany', { rows: list.slice(i, i + 2000), who: S.who, label: 'Imported CSV' })).changed;
  }
  await loadInventory();
  toast(`Import done: ${changed.toLocaleString()} counts changed`);
}

/* ---------- start ---------- */
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

async function init() {
  S.who = ls.get('who');
  $('#who').value = S.who;
  $('#who').addEventListener('change', e => { S.who = e.target.value.trim(); ls.set('who', S.who); });
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  if (MODE === 'sell') {
    try { S.cart = JSON.parse(ls.get('cart') || '[]'); } catch (e) { S.cart = []; }
    try { S.sales = JSON.parse(ls.get('sales') || '[]'); } catch (e) { S.sales = []; }
    renderCart();
    $('#q').addEventListener('input', debounce(renderSell, 120));
    $('#q').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; renderSell(); } });
    $('#grid').addEventListener('click', onTileClick);
    $('#cart').addEventListener('click', onCartClick);
    $('#cart').addEventListener('input', onCartInput);
    $('#cart').addEventListener('change', e => { if (e.target.matches('input.pr')) renderCart(); });
  } else {
    $('#go').addEventListener('click', doSearch);
    $('#aq').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    $('#oos').addEventListener('change', renderSearch);
    $('#sq').addEventListener('input', debounce(renderStock, 120));
    $('#agrid').addEventListener('click', onTileClick);
    $('#stockgrid').addEventListener('click', onTileClick);
    $('#madd').addEventListener('click', addMissingByName);
    $('#mq').addEventListener('keydown', e => { if (e.key === 'Enter') addMissingByName(); });
    $('#mf').addEventListener('input', debounce(renderMissing, 120));
    $('#missgrid').addEventListener('click', onMissingClick);
    $('#export').addEventListener('click', exportCSV);
    $('#importfile').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try { await importCSV(await f.text(), f.name); } catch (x) { toast('Import failed: ' + x.message); }
      e.target.value = '';
    });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  setInterval(poll, POLL_MS);

  loadPrices();
  try { await loadInventory(); }
  catch (e) {
    setSync('Not connected', true);
    $('#banner').innerHTML = `<div class="banner">${esc(e.message)}. You can still see prices, but stock counts can't be shown or changed.</div>`;
  }
}
init();
