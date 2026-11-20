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
  // Email orders follow live stock, but not while someone is typing in the table.
  if (MODE === 'admin' && currentTab() === 'email' && !(document.activeElement || document.body).closest('#etable')) renderEmail();
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
const VIEWS = { sell: ['sell', 'sales'], admin: ['add', 'stock', 'missing', 'email', 'orders', 'history'] }[MODE];
function setTab(tab) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  VIEWS.forEach(t => { $('#v-' + t).hidden = t !== tab; });
  renderAll();
  if (tab === 'history') renderHistory();
  if (tab === 'missing') loadMissing();
  if (tab === 'orders' && !S.ordersLoaded) { setOrderRange('7'); loadOrders(); }
}
function currentTab() { return (document.querySelector('.tabs button.on') || {}).dataset.tab; }
function renderAll() {
  const t = currentTab();
  if (t === 'sell') renderSell();
  else if (t === 'sales') renderSales();
  else if (t === 'add') renderSearch();
  else if (t === 'stock') renderStock();
  else if (t === 'missing') renderMissing();
  else if (t === 'email') renderEmail();
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
    j = await api('sell', { who: S.who, rows: cart.map(l => ({ id: l.id, finish: l.finish, qty: l.qty, price: l.price, meta: { name: l.name, set: l.set, setName: l.setName, cn: l.cn } })) });
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

/* ---------- email orders ---------- */
// Paste a customer's want list; each line is matched to what's in stock, priced at CK NM retail, and
// checked against their budgets. Ticked lines are removed from inventory with one "sell", and the
// customer gets a PDF named after them.
const E_ORANGE = 'orange', E_RED = 'red';
const parseMoney = v => { const n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
function emailBlank() { return { cust: '', card: '', total: '', foil: false, notes: '', text: '', lines: [] }; }
function saveEmail() { ls.set('emaildraft', JSON.stringify(S.email)); }

// Order details typed among the cards, in any order and any reasonable wording:
//   "name: Jane" · "customer - Jane" · "budget: $10" · "$10 total" · "per card budget: $2" · "$2 each" · "max $2/card"
//   "no foils" · "foils: yes" · "foils ok" · "ck pricing: yes" · "notes: ships Friday"
// Returns the details found and the remaining lines (the card list).
function extractOrderInfo(text) {
  const info = {}, rest = [];
  const YES = /\b(yes|y|ok|okay|fine|sure|allowed|include|including|incl|true|good|accept|accepted|please)\b/;
  const NO = /\b(no|n|not|none|without|exclude|excluding|false|nope|dont|don't|never)\b/;
  const amount = s => { const m = s.match(/\$\s*(\d+(?:\.\d{1,2})?)/) || s.match(/(\d+(?:\.\d{1,2})?)\s*(?:\$|dollars?|usd|bucks)/) || s.match(/(?:^|[\s:=])(\d+(?:\.\d{1,2})?)\s*$/) || s.match(/[:=]\s*(\d+(?:\.\d{1,2})?)/); return m ? m[1] : null; };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•·>]+)\s*/, '').trim();
    const s = fold(line).replace(/\s+/g, ' ');
    // A card line ("2 sol ring") never has a $ amount; leave those alone.
    const cardish = /^\d{1,3}\s*[x×]?\s+[a-z]/.test(s) && !/\$/.test(s);
    let m;
    if (!cardish && (m = line.match(/^\s*(?:customer'?s?\s*name|customer|cust|name|for|buyer|client)\s*[:=\-–]\s*(.+)$/i))) { info.cust = m[1].trim(); continue; }
    if (!cardish && (m = line.match(/^\s*notes?\s*[:=\-–]\s*(.+)$/i))) { info.notes = m[1].trim(); continue; }
    if (!cardish && /\bfoils?\b/.test(s) && s.split(' ').length <= 6) { info.foil = !NO.test(s) && (YES.test(s) || !/[:=]/.test(s)); continue; }
    if (!cardish && /\b(ck|card ?kingdom)\b/.test(s) && s.split(' ').length <= 8) continue;   // "CK pricing: yes" lines: not a card, nothing to fill in
    if (!cardish && /\b(budget|total|overall|max|maximum|limit|spend|spending|cap|up to|per|each|apiece)\b|\$|\bdollars?\b/.test(s) && amount(s) != null) {
      const per = /\b(per|each|ea|a card|single|singles|individual|apiece)\b|\/\s*(card|ea|each)\b|\bcard budget\b/.test(s);
      info[per ? 'card' : 'total'] = amount(s);
      continue;
    }
    rest.push(raw);
  }
  return { info, rest: rest.join('\n') };
}

// "4 Lightning Bolt", "4x Lightning Bolt", "Lightning Bolt x4", "1 Lightning Bolt (M11) 146", "- Lightning Bolt"
function parseWantList(text) {
  const out = [];
  for (let raw of String(text || '').split(/\r?\n/)) {
    let s = raw.replace(/^\s*(?:[-*•·>]+|SB:)\s*/i, '').replace(/\s+\*[FE]\*\s*$/i, '').trim();
    if (!s || !/[a-z]/i.test(s) || /:\s*$/.test(s)) continue;                    // blank lines, headings like "Creatures:"
    if (/^(deck|sideboard|commander|maybeboard|companion|total|thanks|thank you)\b/i.test(s) && !/\d/.test(s)) continue;
    let qty = 1, m;
    if ((m = s.match(/^(\d{1,3})\s*[x×]?\s+(.+)$/i))) { qty = +m[1]; s = m[2]; }
    else if ((m = s.match(/^(.+?)\s*[x×]\s*(\d{1,3})$/i)) || (m = s.match(/^(.+?)\s*\((?:x\s*)?(\d{1,3})\)$/i))) { s = m[1]; qty = +m[2]; }
    let set = '', cn = '';
    if ((m = s.match(/^(.+?)\s*[([]\s*([a-z0-9]{2,6})\s*[)\]]\s*([0-9a-z★-]+)?\s*$/i))) { s = m[1]; set = m[2].toLowerCase(); cn = m[3] || ''; }
    s = s.replace(/\s+/g, ' ').trim();
    if (s && qty > 0) out.push({ qty, name: s, set, cn, found: null, pick: '', checked: false, price: null });
  }
  return out;
}

// In-stock printings by folded card name (and by the front face of two-faced cards).
function stockIndex() {
  const idx = new Map();
  const add = (k, e) => { if (!k) return; let a = idx.get(k); if (!a) idx.set(k, a = []); if (!a.includes(e)) a.push(e); };
  for (const e of S.inv.values()) { if (e.qty <= 0 || !e.name) continue; add(nameOf(e), e); if (e.name.includes(' // ')) add(norm(e.name.split(' // ')[0]), e); }
  return idx;
}

// Every in-stock version for a line, cheapest first. Copies already used by earlier lines don't count twice.
function optionsFor(line, idx, used) {
  const list = (idx.get(norm(line.name)) || []).filter(e => S.email.foil || e.key.endsWith('|nonfoil'));
  return list.map(e => {
    const t = { key: e.key, meta: metaFromStock(e), finish: e.key.split('|')[1] };
    return { ...t, have: Math.max(0, e.qty - (used.get(e.key) || 0)), price: priceFor(t, 'nm') };
  }).filter(o => o.have > 0).sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9) || b.have - a.have);
}

// The cheapest version with enough copies for the whole request; if none has enough, the one with the most copies.
// A set named in the list, e.g. "(M11)", wins when we have it.
function pickDefault(opts, qty, set) {
  if (!opts.length) return null;
  const pool = set && opts.some(o => o.meta.set === set) ? opts.filter(o => o.meta.set === set) : opts;
  return pool.find(o => o.have >= qty) || pool.slice().sort((a, b) => b.have - a.have || (a.price ?? 1e9) - (b.price ?? 1e9))[0];
}

const OOS = '__oos';
// When no single version has all the copies asked for, a request becomes side-by-side rows:
// one per version we have (cheapest first, a set named in the list first), then a red row for the rest.
// "4 Lightning Bolt" with 2 × M11 and 2 × M10 → 2 M11 | 2 M10. With only 3 in stock → … | 1 out of stock.
function splitByStock(lines) {
  const idx = stockIndex(), used = new Map(), out = [];
  const take = (l, key, n) => { used.set(key, (used.get(key) || 0) + n); out.push({ ...l, qty: n, pick: key }); };
  for (const l of lines) {
    const opts = optionsFor(l, idx, used);
    const one = pickDefault(opts, l.qty, l.set);
    if (!one) { out.push(l); continue; }
    if (one.have >= l.qty) { take(l, one.key, l.qty); continue; }
    const pool = opts.slice().sort((a, b) => (b.meta.set === l.set) - (a.meta.set === l.set) || (a.price ?? 1e9) - (b.price ?? 1e9) || b.have - a.have);
    let need = l.qty;
    for (const o of pool) { if (!need) break; const n = Math.min(o.have, need); take(l, o.key, n); need -= n; }
    if (need) out.push({ ...l, qty: need, pick: OOS, auto: true });
  }
  return out;
}

// Works out every line: chosen version, price, colour, and whether it counts toward the order (top to bottom).
function computeEmail() {
  const em = S.email, idx = stockIndex(), used = new Map();
  const cardB = parseMoney(em.card), totalB = parseMoney(em.total);
  let total = 0, cards = 0;
  const rows = em.lines.map((l, i) => {
    const opts = optionsFor(l, idx, used);
    // "Out of stock" picked in the version menu (by staff, or for the copies we're short after a split).
    if (l.pick === OOS) return { i, l, opts, o: null, have: 0, price: null, lineTotal: 0, cls: E_RED, flag: l.auto ? 'Out of stock' : 'Marked out of stock', counts: false };
    const o = opts.find(x => x.key === l.pick) || pickDefault(opts, l.qty, l.set);
    const r = { i, l, opts, o, have: 0, price: null, lineTotal: 0, cls: '', flag: '', counts: false };
    if (!o) {
      r.cls = E_RED;
      r.flag = l.found === false ? 'Not found on Scryfall. Check the spelling.' : (idx.get(norm(l.name)) || []).length ? 'Only foil in stock' : 'Out of stock';
      return r;
    }
    r.have = Math.min(l.qty, o.have);
    used.set(o.key, (used.get(o.key) || 0) + r.have);
    r.price = l.price != null ? l.price : o.price;
    const short = r.have < l.qty ? `Have ${r.have} of ${l.qty}. ` : '';
    r.lineTotal = (r.price || 0) * r.have;
    // Over the per-card budget: orange. Staff can still tick it to sell it anyway (it stays orange on the PDF).
    if (r.price != null && cardB != null && r.price > cardB) {
      r.cls = E_ORANGE;
      const fits = opts.some(x => x.price != null && x.price <= cardB);
      r.flag = short + `Over the ${money(cardB)} per-card budget` + (fits ? '. A cheaper version we have fits' : '');
      if (l.checked) { r.flag += ' · added anyway'; total += r.lineTotal; cards += r.have; r.counts = true; }
      return r;
    }
    if (!l.checked) { r.flag = short; return r; }
    if (r.price == null) { r.flag = short + 'No Card Kingdom price. Type one in.'; return r; }
    // Ticked lines fill the overall budget top to bottom. One that doesn't fit turns orange and is left out,
    // unless staff press "Add anyway".
    if (totalB != null && total + r.lineTotal > totalB + 1e-9) {
      r.cls = E_ORANGE;
      r.flag = short + `Would go over the ${money(totalB)} overall budget`;
      if (!l.force) { r.addAnyway = true; return r; }
      r.flag += ' · added anyway';
    }
    total += r.lineTotal; cards += r.have; r.counts = true; if (!r.cls) r.flag = short;
    return r;
  });
  return { rows, total, cards, cardB, totalB };
}

function renderEmail() {
  const em = S.email, box = $('#etable'), foot = $('#efoot');
  if (!em.lines.length) { box.innerHTML = ''; foot.innerHTML = ''; return; }
  const c = computeEmail();
  const verLabel = o => `${o.meta.setName} #${o.meta.cn}${finLabel(o.finish)} · ${o.have} in stock · ${o.price != null ? money(o.price) : 'no CK price'}`;
  box.innerHTML = `<table class="etab"><thead><tr><th title="Tick to include">✓</th><th>Qty</th><th>Card</th><th>Version</th><th title="Box locations come later">Box</th><th>Price ea</th><th class="tot">Total</th><th>Notes</th><th></th></tr></thead><tbody>` +
    c.rows.map(r => {
      const l = r.l, o = r.o;
      const name = l.found === false ? `<input type="text" class="en" data-e="name" value="${esc(l.name)}" aria-label="Card name">` : `<span class="ename">${esc(l.name)}</span>`;
      // The first choice is always "Out of stock", for when the count says we have it but the copy can't be found.
      const ver = o || l.pick === OOS ? `<select data-e="pick" aria-label="Version"><option value="${OOS}"${o ? '' : ' selected'}>Out of stock</option>${r.opts.map(x => `<option value="${esc(x.key)}"${o && x.key === o.key ? ' selected' : ''}>${esc(verLabel(x))}</option>`).join('')}</select>` : '';
      const price = !o ? '' : o.price == null || l.price != null
        ? `$<input type="text" class="ep" data-e="price" inputmode="decimal" value="${r.price != null ? r.price.toFixed(2) : ''}" placeholder="price"> ${o.price == null ? `<a href="${esc(tcgUrl(o.meta))}" target="_blank" rel="noopener" class="hint">TCG ↗</a>` : ''}`
        : money(r.price);
      return `<tr class="${r.cls}" data-i="${r.i}">
        <td>${o ? `<input type="checkbox" data-e="chk" ${l.checked ? 'checked' : ''} aria-label="Include">` : ''}</td>
        <td><input type="text" class="eq" data-e="qty" inputmode="numeric" value="${l.qty}" aria-label="Quantity"></td>
        <td>${name}</td><td>${ver}</td><td class="muted">—</td><td>${price}</td>
        <td class="tot">${r.counts ? money(r.lineTotal) : ''}</td>
        <td class="flag">${l.typed ? `<span class="muted">Corrected from "${esc(l.typed)}". </span>` : ''}${esc(r.flag)}${r.addAnyway ? ` <a href="#" data-e="force" class="hint">Add anyway</a>` : ''}${o && r.have < l.qty ? ` <a href="#" data-e="more" class="hint">+ another version</a>` : ''}</td>
        <td><button class="erm" data-e="rm" title="Remove this line" aria-label="Remove line">×</button></td></tr>`;
    }).join('') + '</tbody></table>';
  const left = c.totalB != null ? ` <span class="muted">· ${money(Math.max(0, c.totalB - c.total))} of ${money(c.totalB)} budget left</span>` : '';
  foot.innerHTML = `<button data-e="tickall">Tick all in stock</button><span>${c.cards} card${c.cards === 1 ? '' : 's'} · <span class="big">${money(c.total)}</span>${left}</span>
    <button class="primary" data-e="complete" ${c.cards && !S.emailBusy ? '' : 'disabled'}>${S.emailBusy ? 'Saving order…' : 'Complete order'}</button>`;
  const red = c.rows.filter(r => r.cls === E_RED).length;
  $('#enote').textContent = `${em.lines.length} line${em.lines.length === 1 ? '' : 's'}, ${red} out of stock.`;
}

function emailFormIn() {
  const em = S.email;
  em.cust = $('#ecust').value.trim(); em.card = $('#ecard').value; em.total = $('#etotal').value;
  em.foil = $('#efoil').checked; em.notes = $('#enotes').value; em.text = $('#elist').value;
}
function emailFormOut() {
  const em = S.email;
  $('#ecust').value = em.cust; $('#ecard').value = em.card; $('#etotal').value = em.total;
  $('#efoil').checked = em.foil; $('#enotes').value = em.notes; $('#elist').value = em.text;
  $('#elastpdf').hidden = !ls.get('emaillast');
}

// Closest real card name by spelling, for typos Scryfall's fuzzy search gives up on ("sol rnig" → Sol Ring).
// Scryfall's list of every card name (~1 MB) is downloaded once per page load.
let cardNameList = null;
const spell = s => fold(s).replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
async function closestCardName(typed) {
  if (!cardNameList) {
    await throttle();
    const r = await fetch('https://api.scryfall.com/catalog/card-names', { headers: SF_HEADERS });
    if (!r.ok) throw new Error('Scryfall returned ' + r.status);
    cardNameList = [];
    for (const n of (await r.json()).data) {
      cardNameList.push({ n, s: spell(n) });
      if (n.includes(' // ')) cardNameList.push({ n, s: spell(n.split(' // ')[0]) });
    }
  }
  const t = spell(typed);
  const limit = Math.max(1, Math.min(4, Math.floor(t.length / 4)));   // ~1 slip per 4 letters, at most 4
  let ties = [], bestD = limit + 1;
  for (const c of cardNameList) {
    if (Math.abs(c.s.length - t.length) > bestD) continue;
    const d = editDistance(t, c.s, bestD + 1);
    if (d < bestD) { bestD = d; ties = [c]; }
    else if (d === bestD) ties.push(c);
  }
  if (!ties.length) return '';
  // Equally close names ("lightnig blot": Lightning Bolt or Lightning Blow): prefer one we stock,
  // then the one using the same letters (swapped letters are the commonest slip).
  const idx = stockIndex(), letters = s => s.replace(/ /g, '').split('').sort().join('');
  const lt = letters(t);
  const score = c => (idx.has(norm(c.n)) ? 0 : 100) + editDistance(lt, letters(c.s), 99);
  return ties.sort((a, b) => score(a) - score(b))[0].n;
}
// Letters added, dropped, changed or swapped; stops early once it's over `max`.
function editDistance(a, b, max) {
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v); if (v < rowMin) rowMin = v;
    }
    if (rowMin >= max) return max;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}

// Names not in stock are checked on Scryfall so typos show up (and a fixed typo can still match our stock).
async function resolveNames(lines) {
  const idx = stockIndex();
  const unknown = lines.filter(l => !idx.has(norm(l.name)));
  lines.forEach(l => { const hit = idx.get(norm(l.name)); if (hit) { l.found = true; l.name = hit[0].name; } });
  for (let i = 0; i < unknown.length; i += 75) {
    const chunk = unknown.slice(i, i + 75);
    await throttle();
    const r = await fetch('https://api.scryfall.com/cards/collection', { method: 'POST', headers: { 'Content-Type': 'application/json', ...SF_HEADERS }, body: JSON.stringify({ identifiers: chunk.map(l => ({ name: l.name })) }) });
    if (!r.ok) throw new Error('Scryfall returned ' + r.status);
    const j = await r.json();
    const byName = new Map();
    (j.data || []).forEach(c => { byName.set(norm(c.name), c.name); if (c.name.includes(' // ')) byName.set(norm(c.name.split(' // ')[0]), c.name); });
    chunk.forEach(l => { const n = byName.get(norm(l.name)); if (n) { l.found = true; l.name = n; } });
  }
  // Misspellings: Scryfall's fuzzy match ("embrase the paradox" → Embrace the Paradox), then its
  // autocomplete for names it finds ambiguous. The note on the row says what was typed.
  for (const l of unknown.filter(x => !x.found).slice(0, 120)) {
    const typed = l.name;
    await throttle();
    let r = await fetch('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(typed), { headers: SF_HEADERS });
    let name = r.ok ? (await r.json()).name : '';
    if (!name) name = await closestCardName(typed).catch(() => '');
    if (!name) {
      await throttle();
      r = await fetch('https://api.scryfall.com/cards/autocomplete?q=' + encodeURIComponent(typed), { headers: SF_HEADERS });
      const j = r.ok ? await r.json() : null;
      name = (j && j.data && j.data[0]) || '';
    }
    if (name) { l.found = true; l.name = name; if (norm(name) !== norm(typed)) l.typed = typed; }
    else l.found = false;
  }
}

async function checkEmailList() {
  emailFormIn();
  // Order details pasted with the list (name, budgets, foils…) fill in the boxes above; the rest is the card list.
  const { info, rest } = extractOrderInfo(S.email.text);
  const filled = [];
  if (info.cust != null) { $('#ecust').value = info.cust; filled.push('name'); }
  if (info.total != null) { $('#etotal').value = info.total; filled.push('overall budget'); }
  if (info.card != null) { $('#ecard').value = info.card; filled.push('per-card budget'); }
  if (info.foil != null) { $('#efoil').checked = info.foil; filled.push('foils'); }
  if (info.notes != null) { $('#enotes').value = info.notes; filled.push('notes'); }
  emailFormIn();
  if (filled.length) toast('Filled in from the list: ' + filled.join(', '));
  const lines = parseWantList(rest);
  if (!lines.length) { toast('Paste the card list first'); $('#elist').focus(); return; }
  if (!S.loaded) { toast('The inventory has not loaded yet'); return; }
  $('#echeck').disabled = true; $('#enote').textContent = 'Checking the list…';
  try { await resolveNames(lines); }
  catch (e) { toast('Could not check names on Scryfall (' + e.message + '). In-stock cards still work.'); }
  finally { $('#echeck').disabled = false; }
  S.email.lines = splitByStock(lines); saveEmail(); renderEmail();
}

function onEmailEvent(e) {
  const el = e.target.closest('[data-e]'); if (!el) return;
  const act = el.dataset.e, tr = el.closest('tr'), l = tr ? S.email.lines[+tr.dataset.i] : null;
  if (e.type === 'click' && !['rm', 'more', 'tickall', 'complete', 'force'].includes(act)) return;
  if (e.type === 'click') e.preventDefault();
  if (act === 'complete') return completeEmailOrder();
  if (act === 'tickall') { const c = computeEmail(); c.rows.forEach(r => { if (r.o && r.cls !== E_ORANGE) r.l.checked = true; }); }   // over-budget cards are only added one by one
  else if (act === 'rm') S.email.lines.splice(+tr.dataset.i, 1);
  else if (act === 'more') { const r = computeEmail().rows[+tr.dataset.i]; S.email.lines.splice(+tr.dataset.i + 1, 0, { ...l, qty: l.qty - r.have, pick: '', price: null }); l.qty = r.have; }
  else if (act === 'chk') { l.checked = el.checked; if (!l.checked) l.force = false; }
  else if (act === 'force') { l.checked = true; l.force = true; }
  else if (act === 'pick') { l.pick = el.value; l.price = null; l.auto = false; }
  else if (act === 'qty') { const q = parseInt(el.value, 10); if (q > 0) l.qty = Math.min(999, q); }
  else if (act === 'price') l.price = parseMoney(el.value);
  else if (act === 'name') { l.name = el.value.trim(); l.found = null; l.typed = ''; resolveNames([l]).catch(() => {}).then(() => { saveEmail(); renderEmail(); }); return; }
  saveEmail(); renderEmail();
}

async function completeEmailOrder() {
  if (S.emailBusy) return;
  emailFormIn();
  const em = S.email;
  if (!em.cust) { toast('Type the customer name first. It names their PDF.'); $('#ecust').focus(); return; }
  if (!S.who) { toast('Enter your name (top right) first so the order is logged'); $('#who').focus(); return; }
  const c = computeEmail();
  const take = c.rows.filter(r => r.counts);
  if (!take.length) { toast('Tick at least one card that is in stock'); return; }
  const noPrice = c.rows.find(r => r.l.checked && r.o && r.price == null && r.cls !== E_ORANGE);
  if (noPrice) { toast(`Type a price for ${noPrice.l.name} or untick it`); return; }
  if (!confirm(`Remove ${c.cards} card${c.cards === 1 ? '' : 's'} (${money(c.total)}) from inventory for ${em.cust}?`)) return;
  S.emailBusy = true; renderEmail();
  let j;
  try {
    j = await api('sell', { who: S.who, customer: em.cust, rows: take.map(r => ({ id: r.o.meta.id, finish: r.o.finish, qty: r.have, price: r.price, meta: { name: r.o.meta.name, set: r.o.meta.set, setName: r.o.meta.setName, cn: r.o.meta.cn } })) });
  } catch (e) {
    S.emailBusy = false; renderEmail();
    toast('Order NOT saved: ' + e.message.replace(/\.$/, '') + '. Nothing was removed from inventory.');
    return;
  }
  // What the server actually removed, shared across lines in list order (stock can change while you work).
  const left = new Map(j.items.map(it => [it.key, it.sold]));
  for (const it of j.items) { const r = take.find(x => x.o.key === it.key); setLocalQty(it.key, it.qty, { name: r.o.meta.name, set: r.o.meta.set, setName: r.o.meta.setName, cn: r.o.meta.cn }); }
  const pdfRows = [];
  for (const r of c.rows) {
    const v = r.o ? `${r.o.meta.setName} #${r.o.meta.cn}${finLabel(r.o.finish)}` : '';
    if (r.counts) {
      const sold = Math.min(r.have, left.get(r.o.key) || 0); left.set(r.o.key, (left.get(r.o.key) || 0) - sold);
      pdfRows.push(sold ? { qty: sold, asked: r.l.qty, name: r.l.name, ver: v, price: r.price, total: r.price * sold, cls: r.cls === E_ORANGE ? E_ORANGE : '', given: true } : { qty: r.l.qty, asked: r.l.qty, name: r.l.name, ver: '', cls: E_RED });
    } else if (r.cls === E_RED) pdfRows.push({ qty: r.l.qty, asked: r.l.qty, name: r.l.name, ver: '', cls: E_RED });
    else if (r.cls === E_ORANGE) pdfRows.push({ qty: r.have, asked: r.l.qty, name: r.l.name, ver: v, price: r.price, cls: E_ORANGE });
  }
  const done = { order: j.order, n: j.customerN || 1, cust: em.cust, time: new Date().toISOString(), rows: pdfRows, total: pdfRows.reduce((n, x) => n + (x.given ? x.total : 0), 0), budget: c.totalB };
  ls.set('emaillast', JSON.stringify(done));
  S.email = emailBlank(); saveEmail(); emailFormOut();
  S.emailBusy = false; renderEmail();
  const removed = pdfRows.filter(x => x.given).reduce((n, x) => n + x.qty, 0);
  $('#emodal').innerHTML = `<div class="box" role="dialog" aria-label="Order complete"><h2>Order #${esc(done.order)} complete</h2>
    <p>${esc(done.cust)}: <b>${money(done.total)}</b>, ${removed} card${removed === 1 ? '' : 's'} removed from inventory.</p>
    <div class="row"><button data-m="close">Close</button><button class="primary" data-m="pdf">Download PDF (${esc(pdfName(done))})</button></div></div>`;
  $('#emodal').hidden = false;
}

const pdfName = d => (d.cust.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Order') + (d.n > 1 ? d.n : '') + '.pdf';
function loadScript(src) { return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Could not load the PDF maker')); document.head.appendChild(s); }); }
async function logoDataUrl() {
  const b = await (await fetch('logo.png')).blob();
  return new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); });
}

// The customer's copy: logo, their name, a colour guide, and every card with what we had.
async function emailPdf(d) {
  if (!window.jspdf) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
  const W = 612, M = 40, FILL = { orange: [255, 217, 168], red: [249, 201, 201] };
  try { doc.addImage(await logoDataUrl(), 'PNG', M, 32, 64, 64); } catch (e) {}
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.text('Big Brother Comics', M + 78, 58);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(12);
  doc.text(`Card order for ${d.cust}`, M + 78, 78);
  doc.setFontSize(10); doc.setTextColor(100);
  doc.text(`Order #${d.order}  ·  ${new Date(d.time).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })}`, W - M, 58, { align: 'right' });
  doc.text('Prices: Card Kingdom Near Mint retail', W - M, 74, { align: 'right' });
  let y = 116;
  doc.setTextColor(30);
  doc.setFillColor(...FILL.orange); doc.rect(M, y - 9, 11, 11, 'F'); doc.text('Orange rows: over budget', M + 16, y);
  doc.setFillColor(...FILL.red); doc.rect(M + 170, y - 9, 11, 11, 'F'); doc.text('Red rows: out of stock', M + 186, y);
  y += 24;
  const cols = [{ t: 'Qty', x: M + 4 }, { t: 'Card', x: M + 54 }, { t: 'Version', x: M + 270 }, { t: 'Price ea', x: W - M - 74, r: true }, { t: 'Total', x: W - M - 4, r: true }];
  const fit = (s, w) => { s = String(s || ''); if (doc.getTextWidth(s) <= w) return s; while (s && doc.getTextWidth(s + '…') > w) s = s.slice(0, -1); return s + '…'; };
  const head = () => { doc.setFont('helvetica', 'bold'); cols.forEach(c => doc.text(c.t, c.x, y, c.r ? { align: 'right' } : undefined)); doc.setDrawColor(180); doc.line(M, y + 5, W - M, y + 5); doc.setFont('helvetica', 'normal'); y += 20; };
  head();
  for (const r of d.rows) {
    if (y > 740) { doc.addPage(); y = 50; head(); }
    if (r.cls) { doc.setFillColor(...FILL[r.cls]); doc.rect(M, y - 12, W - 2 * M, 17, 'F'); }
    // Only the number of copies on that row: what we're giving them, or (red) what we couldn't. Never our stock.
    doc.text(String(r.cls === E_RED ? r.asked : r.qty), cols[0].x, y);
    doc.text(fit(r.name, 210), cols[1].x, y);
    doc.text(fit(r.cls === E_RED ? 'Out of stock' : r.ver, 150), cols[2].x, y);
    if (r.cls !== E_RED && r.price != null) doc.text(money(r.price), cols[3].x, y, { align: 'right' });
    doc.text(r.given ? money(r.total) : r.cls === E_ORANGE ? 'Over budget' : '', cols[4].x, y, { align: 'right' });
    y += 17;
  }
  if (y > 730) { doc.addPage(); y = 50; }
  doc.setDrawColor(180); doc.line(M, y - 6, W - M, y - 6);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  doc.text(`Total: ${money(d.total)}`, W - M - 4, y + 12, { align: 'right' });
  if (d.budget != null) { doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(`Your budget: ${money(d.budget)}`, W - M - 4, y + 28, { align: 'right' }); }
  doc.save(pdfName(d));
}

async function downloadEmailPdf() {
  let d; try { d = JSON.parse(ls.get('emaillast')); } catch (e) {}
  if (!d) { toast('No completed email order on this computer yet'); return; }
  try { await emailPdf(d); } catch (e) { toast('PDF failed: ' + e.message); }
}

/* ---------- past orders ---------- */
// Find completed orders (sales screen and email orders) by day, customer/staff/order number and total,
// and reverse one: every card in it goes back into stock, logged "Reversed #N".
const dayStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function setOrderRange(r) {
  const today = new Date(), from = new Date();
  if (r === 'all') { $('#ofrom').value = ''; $('#oto').value = ''; return; }
  if (r === 'yesterday') { from.setDate(today.getDate() - 1); $('#ofrom').value = $('#oto').value = dayStr(from); return; }
  if (r !== 'today') from.setDate(today.getDate() - (Number(r) - 1));
  $('#ofrom').value = dayStr(from); $('#oto').value = dayStr(today);
}

async function loadOrders() {
  const from = $('#ofrom').value, to = $('#oto').value;
  if (from && to && from > to) { toast('"From" is after "To"'); return; }
  const min = $('#omin').value.trim(), max = $('#omax').value.trim();
  if ((min && parseMoney(min) == null) || (max && parseMoney(max) == null)) { toast('Type the totals as numbers, e.g. 25'); return; }
  S.ordersLoaded = true;
  $('#onote').textContent = 'Loading orders…'; $('#onote').classList.remove('err');
  try {
    const j = await api('orders', {
      from: from ? new Date(from + 'T00:00:00').toISOString() : '',            // whole days, in this computer's time zone
      to: to ? new Date(to + 'T23:59:59.999').toISOString() : '',
      q: $('#oq').value.trim(), min: min ? parseMoney(min) : '', max: max ? parseMoney(max) : '', limit: 500,
    });
    S.orders = j.orders; S.ordersCount = j.count;
    renderOrders();
  } catch (e) { $('#onote').textContent = 'Could not load orders: ' + e.message; $('#onote').classList.add('err'); }
}

function renderOrders() {
  const list = (S.orders || []).filter(o => $('#oshowrev').checked || !o.reversed);
  const when = s => new Date(s).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const live = list.filter(o => !o.reversed);
  const sum = live.reduce((n, o) => n + (o.total || 0), 0), cards = live.reduce((n, o) => n + o.cards, 0);
  $('#onote').textContent = !list.length ? 'No orders match.' :
    `${list.length} order${list.length === 1 ? '' : 's'}` + (S.ordersCount > S.orders.length ? ` (showing the newest ${S.orders.length} of ${S.ordersCount})` : '') +
    ` · ${cards} card${cards === 1 ? '' : 's'} · ${money(sum)} not counting reversed orders` + (live.some(o => o.total == null) ? ' (some older orders have no price recorded)' : '') + '.';
  $('#olist').innerHTML = list.map(o => {
    const items = o.items.map(x => `<li><span>${x[1]} × ${esc(x[3] || 'Card')}${finLabel(String(x[0]).split('|')[1])} <span class="muted">${esc(String(x[4] || '').toUpperCase())}${x[6] ? ' #' + esc(x[6]) : ''}</span></span><span>${x[2] != null ? money(x[2] * x[1]) : ''}</span></li>`).join('');
    return `<details class="ord${o.reversed ? ' rev' : ''}" data-order="${esc(o.order)}">
      <summary><span class="onum">#${esc(o.order)}</span><span>${esc(when(o.time))}</span>
        ${o.customer ? `<span class="otag email">Email: ${esc(o.customer)}</span>` : '<span class="otag">In store</span>'}
        <span class="muted">by ${esc(o.who)} · ${o.cards} card${o.cards === 1 ? '' : 's'}</span>
        ${o.reversed ? `<span class="otag done">Reversed ${esc(when(o.reversed))} by ${esc(o.reversedBy)}</span>` : ''}
        <span class="otot">${o.total != null ? money(o.total) : '<span class="muted" style="font-size:13px;font-weight:500">no price recorded</span>'}</span></summary>
      <div class="obody"><ul>${items}</ul>
        <div class="row">${o.reversed ? '<span class="muted">These cards were already put back into stock.</span>' : `<button data-oact="reverse">Reverse order: put these ${o.cards} card${o.cards === 1 ? '' : 's'} back in stock</button>`}</div></div>
    </details>`;
  }).join('');
}

async function onOrdersClick(e) {
  const b = e.target.closest('[data-oact]'); if (!b) return;
  const order = b.closest('.ord').dataset.order;
  const o = (S.orders || []).find(x => String(x.order) === order); if (!o) return;
  if (!S.who) { toast('Enter your name (top right) first so the reversal is logged'); $('#who').focus(); return; }
  if (!confirm(`Reverse order #${order}${o.customer ? ' for ' + o.customer : ''}${o.total != null ? ' (' + money(o.total) + ')' : ''}?\n\nThis puts ${o.cards} card${o.cards === 1 ? '' : 's'} back into inventory. It can't be undone from here.`)) return;
  b.disabled = true; b.textContent = 'Reversing…';
  try {
    const j = await api('reverse', { order, who: S.who });
    j.items.forEach(x => { setLocalQty(x.key, x.qty, x); refreshTile(x.key); });
    toast(`Order #${order} reversed: ${o.cards} card${o.cards === 1 ? '' : 's'} back in stock`);
    await loadOrders();
  } catch (x) { b.disabled = false; b.textContent = 'Reverse order'; toast('Not reversed: ' + x.message); }
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
    try { S.email = { ...emailBlank(), ...JSON.parse(ls.get('emaildraft') || '{}') }; } catch (e) { S.email = emailBlank(); }
    emailFormOut();
    $('#echeck').addEventListener('click', checkEmailList);
    $('#enew').addEventListener('click', () => {
      if (S.email.lines.length && !confirm('Clear this email order and start a new one? Nothing is removed from inventory.')) return;
      S.email = emailBlank(); saveEmail(); emailFormOut(); renderEmail(); $('#enote').textContent = '';
    });
    $('#elastpdf').addEventListener('click', downloadEmailPdf);
    $('#ogo').addEventListener('click', loadOrders);
    ['#oq', '#omin', '#omax'].forEach(s => $(s).addEventListener('keydown', e => { if (e.key === 'Enter') loadOrders(); }));
    ['#ofrom', '#oto'].forEach(s => $(s).addEventListener('change', loadOrders));
    $('#oshowrev').addEventListener('change', renderOrders);
    document.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => { setOrderRange(b.dataset.range); loadOrders(); }));
    $('#olist').addEventListener('click', onOrdersClick);
    // Budget and foil answers re-check the table straight away; the rest is just saved.
    ['#ecust', '#ecard', '#etotal', '#efoil', '#enotes', '#elist'].forEach(s => $(s).addEventListener('input', debounce(() => { emailFormIn(); saveEmail(); renderEmail(); }, 250)));
    $('#efoil').addEventListener('change', () => { emailFormIn(); saveEmail(); renderEmail(); });
    ['#etable', '#efoot'].forEach(s => { $(s).addEventListener('click', onEmailEvent); $(s).addEventListener('change', onEmailEvent); });
    $('#emodal').addEventListener('click', e => {
      const b = e.target.closest('[data-m]');
      if (b && b.dataset.m === 'pdf') downloadEmailPdf();
      if ((b && b.dataset.m === 'close') || e.target.id === 'emodal') $('#emodal').hidden = true;
    });
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
