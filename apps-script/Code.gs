/**
 * Big Brother Comics card inventory: shared backend.
 *
 * Paste this into Extensions > Apps Script on the inventory Google Sheet, then
 * Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 *
 * Tabs (created automatically on first use):
 *   Inventory  one row per printing + finish, with the live quantity
 *   Log        every change: who, when, what, and the quantity afterwards
 *   Missing    cards the store is sure it's missing
 *   Orders     every completed order with prices (for finding and reversing orders)
 *
 *   EmailOrders  customer want-list emails (Gmail label "lists") read by Claude, with To do / done and checklist status.
 *              Needs the Anthropic key (Script Property ANTHROPIC_KEY, set from the app) and one run of setupEmail() for Gmail access + the timer.
 *   Account    the store's one username + salted password hash (created by the app's first-run "Create store profile")
 *
 * Sign-in: the app sends a long random session token (kept for years, see SESSION_IDLE_MS); only its hash is stored,
 * one Script Property per device (S_...). The edit's author is always the signed-in username (set here, not by the app).
 * The Scryfall extension instead sends the secret key built into it (checked against EXT_KEY_HASH), logged as "Scryfall". If the password is forgotten, delete row 2 of the Account tab and
 * create the profile again in the app (that also signs out every device).
 */

var INV = 'Inventory';
var LOG = 'Log';
var INV_HEAD = ['key', 'scryfall_id', 'finish', 'qty', 'name', 'set', 'set_name', 'collector_number', 'updated', 'updated_by'];
var LOG_HEAD = ['seq', 'time', 'who', 'action', 'key', 'name', 'set', 'set_name', 'collector_number', 'finish', 'change', 'qty_after'];
var FINISHES = { nonfoil: 1, foil: 1, etched: 1 };
// Cards the store knows it is missing: one row per card (Scryfall oracle id), shown as its original printing.
var MISS = 'Missing';
var MISS_HEAD = ['oracle_id', 'name', 'scryfall_id', 'set', 'set_name', 'collector_number', 'added', 'added_by'];
// Every completed order with its prices, so the back office can find and reverse it.
// items = JSON [[key, sold, price, name, set, set_name, cn], ...]
var ORD = 'Orders';
var ORD_HEAD = ['order', 'time', 'who', 'customer', 'total', 'cards', 'items', 'reversed', 'reversed_by'];

var ACCT = 'Account';
var ACCT_HEAD = ['username', 'salt', 'password_hash', 'created', 'changed'];
var PUBLIC_ACTIONS = { authStatus: 1, setup: 1, login: 1 };
var EXT_ACTIONS = { inventory: 1, changes: 1, adjust: 1, lookup: 1, missing: 1, missingAdd: 1, missingRemove: 1 };
var SESSION_IDLE_MS = 3650 * 86400000;   // a device stays signed in until it has gone unused for ~10 years
var HASH_ROUNDS = 400;
// The Scryfall extension has a secret key built into it (nobody types it). Only the hash is here: sha_('ext:' + key).
var EXT_KEY_HASH = 'qLgh/zIl7OnZwBGb5OeG6IMfWB+w2BP1IF5GqxmqpUU=';

function doGet() {
  return json_({ ok: true, service: 'card-inventory', time: new Date().toISOString() });
}

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  try {
    var fn = ACTIONS[body.action];
    if (!fn) return json_({ ok: false, error: 'Unknown action' });
    // Everything except signing in needs the store account's session token, or (for the few things the Scryfall
    // extension does) the extension key. The extension's changes are always logged as "Scryfall".
    if (!PUBLIC_ACTIONS[body.action]) {
      var who = authorize_(body);
      if (!who) return json_({ ok: false, needLogin: true, setup: !acct_(), error: 'Not signed in. Sign in to the app, or update the Scryfall extension to the latest version.' });
      // Who made the change is always decided here: the signed-in account's username, or "Scryfall" for the extension.
      body.who = who.ext ? 'Scryfall' : who.user;
    }
    return json_(fn(body));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

var ACTIONS = {
  // Everything in stock, plus the latest log number so the app can ask for changes after it.
  inventory: function () {
    var s = sheets_();
    var n = s.inv.getLastRow() - 1;
    var rows = [];
    if (n > 0) {
      var v = s.inv.getRange(2, 1, n, 8).getValues();
      for (var i = 0; i < v.length; i++) {
        var r = v[i];
        if (r[0] && Number(r[3]) > 0) rows.push([String(r[0]), Number(r[3]), String(r[4]), String(r[5]), String(r[6]), String(r[7])]);
      }
    }
    return { ok: true, seq: lastSeq_(s.log), rows: rows };
  },

  // Changes made since log number since (by anyone), oldest first.
  changes: function (b) {
    var s = sheets_();
    var last = lastSeq_(s.log);
    var since = Math.max(0, Number(b.since) || 0);
    if (since >= last) return { ok: true, seq: last, changes: [] };
    if (last - since > 5000) return { ok: true, seq: last, reload: true };
    var v = s.log.getRange(since + 2, 1, last - since, LOG_HEAD.length).getValues();
    return { ok: true, seq: last, changes: v.map(function (r) { return { seq: r[0], key: String(r[4]), qty: Number(r[11]), name: String(r[5]), set: String(r[6]), setName: String(r[7]), cn: String(r[8]) }; }) };
  },

  // Add or remove copies. Changes are relative (+1 / -1) so two people editing at once both count.
  adjust: function (b) {
    var who = clean_(b.who, 60);
    if (!who) throw new Error('Enter your name first');
    var delta = Math.round(Number(b.delta));
    if (!delta || Math.abs(delta) > 1000) throw new Error('Bad quantity change');
    var item = item_(b);
    return withLock_(function (s) {
      var row = findRow_(s.inv, item.key);
      var old = row ? s.inv.getRange(row, 1, 1, INV_HEAD.length).getValues()[0] : null;
      var cur = old ? Number(old[3]) || 0 : 0;
      keep_(item, old);
      var qty = Math.max(0, cur + delta);
      if (qty === cur) return { ok: true, qty: qty, seq: lastSeq_(s.log), unchanged: true };
      var now = new Date();
      var vals = [item.key, item.id, item.finish, qty, item.name, item.set, item.setName, item.cn, now, who];
      if (row) s.inv.getRange(row, 1, 1, vals.length).setValues([vals]);
      else s.inv.appendRow(vals);
      var seq = lastSeq_(s.log) + 1;
      s.log.appendRow([seq, now, who, delta > 0 ? 'Added' : 'Removed', item.key, item.name, item.set, item.setName, item.cn, item.finish, qty - cur, qty]);
      return { ok: true, qty: qty, seq: seq };
    });
  },

  // Set exact quantities for many printings at once (CSV import).
  setMany: function (b) {
    var who = clean_(b.who, 60);
    if (!who) throw new Error('Enter your name first');
    var list = (b.rows || []).slice(0, 20000).map(function (r) { var it = item_(r); it.qty = Math.max(0, Math.round(Number(r.qty) || 0)); return it; });
    var label = clean_(b.label, 60) || 'Imported';
    return withLock_(function (s) {
      var n = s.inv.getLastRow() - 1;
      var data = n > 0 ? s.inv.getRange(2, 1, n, INV_HEAD.length).getValues() : [];
      var at = {};
      for (var i = 0; i < data.length; i++) at[data[i][0]] = i;
      var now = new Date(), seq = lastSeq_(s.log), logs = [], changed = 0;
      list.forEach(function (it) {
        var i = at[it.key];
        var cur = i === undefined ? 0 : Number(data[i][3]) || 0;
        if (cur === it.qty) return;
        keep_(it, i === undefined ? null : data[i]);
        var vals = [it.key, it.id, it.finish, it.qty, it.name, it.set, it.setName, it.cn, now, who];
        if (i === undefined) { at[it.key] = data.length; data.push(vals); } else data[i] = vals;
        logs.push([++seq, now, who, label, it.key, it.name, it.set, it.setName, it.cn, it.finish, it.qty - cur, it.qty]);
        changed++;
      });
      if (data.length) s.inv.getRange(2, 1, data.length, INV_HEAD.length).setValues(data);
      if (logs.length) s.log.getRange(s.log.getLastRow() + 1, 1, logs.length, LOG_HEAD.length).setValues(logs);
      return { ok: true, changed: changed, seq: seq };
    });
  },

  // Complete an order: remove every line from stock in one step. Lines asking for more than is in
  // stock remove what is there; the reply says how many of each were actually removed.
  // Orders are numbered 1, 2, 3... store-wide (Script Property ORDER_SEQ), assigned under the lock.
  sell: function (b) {
    var who = clean_(b.who, 60);
    if (!who) throw new Error('Enter your name first');
    var merged = {}, list = [], lines = [];
    (b.rows || []).slice(0, 500).forEach(function (r) {
      var it = item_(r), q = Math.max(0, Math.round(Number(r.qty) || 0));
      if (!q) return;
      var p = Number(r.price);
      lines.push({ key: it.key, qty: q, price: isFinite(p) && p >= 0 && r.price !== null && r.price !== '' ? Math.round(p * 100) / 100 : null, it: it });
      if (merged[it.key]) merged[it.key].qty += q; else { it.qty = q; merged[it.key] = it; list.push(it); }
    });
    if (!list.length) throw new Error('The order is empty');
    return withLock_(function (s) {
      var props = PropertiesService.getScriptProperties();
      var order = (Number(props.getProperty('ORDER_SEQ')) || 0) + 1;
      props.setProperty('ORDER_SEQ', String(order));
      var action = 'Sold #' + order;
      // Email orders: count orders per customer name (Script Property CUSTOMER_COUNTS) so their PDF
      // is "Jane Doe.pdf", then "Jane Doe2.pdf"... the same on every computer.
      var customer = clean_(b.customer, 80), customerN = 0;
      if (customer) {
        var counts = {};
        try { counts = JSON.parse(props.getProperty('CUSTOMER_COUNTS') || '{}'); } catch (e) { counts = {}; }
        var ck = customer.toLowerCase();
        customerN = counts[ck] = (Number(counts[ck]) || 0) + 1;
        props.setProperty('CUSTOMER_COUNTS', JSON.stringify(counts));
        action += ' (Email: ' + customer + ')';
      }
      var now = new Date(), seq = lastSeq_(s.log), logs = [], items = [];
      list.forEach(function (it) {
        var row = findRow_(s.inv, it.key);
        var old = row ? s.inv.getRange(row, 1, 1, INV_HEAD.length).getValues()[0] : null;
        var cur = old ? Number(old[3]) || 0 : 0;
        var take = Math.min(cur, it.qty);
        items.push({ key: it.key, asked: it.qty, sold: take, qty: cur - take });
        if (!take) return;
        keep_(it, old);
        s.inv.getRange(row, 1, 1, INV_HEAD.length).setValues([[it.key, it.id, it.finish, cur - take, it.name, it.set, it.setName, it.cn, now, who]]);
        logs.push([++seq, now, who, action, it.key, it.name, it.set, it.setName, it.cn, it.finish, -take, cur - take]);
      });
      if (logs.length) s.log.getRange(s.log.getLastRow() + 1, 1, logs.length, LOG_HEAD.length).setValues(logs);
      // Record the order with what was actually removed, line by line in order, at each line's price.
      var left = {}, rec = [], total = 0, cards = 0;
      items.forEach(function (x) { left[x.key] = x.sold; });
      lines.forEach(function (l) {
        var n = Math.min(l.qty, left[l.key] || 0); if (!n) return;
        left[l.key] -= n; cards += n; total += (l.price || 0) * n;
        var it = merged[l.key];
        rec.push([l.key, n, l.price, it.name, it.set, it.setName, it.cn]);
      });
      if (rec.length) ordTab_().appendRow([String(order), now, who, customer, Math.round(total * 100) / 100, cards, itemsJson_(rec), '', '']);
      // An order made from a customer email closes that email (Gmail label "complete") so it leaves the To do list.
      // A Gmail hiccup never undoes the sale.
      var emailDone = false;
      if (b.emailThread) { try { markEmailDone_(String(b.emailThread), who, order); emailDone = true; } catch (e) {} }
      return { ok: true, seq: seq, order: order, items: items, customerN: customerN, emailDone: emailDone };
    });
  },

  /* ----- customer want-list emails (Gmail label "lists") ----- */

  // The To do list (no Gmail or AI work; just what the last sync stored).
  emails: function () { return emailsReply_(); },

  // Look at Gmail now: new/changed "lists" threads are read by the AI, finished ones leave the To do list.
  emailSync: function () { syncEmails_(8); return emailsReply_(); },

  // Mark an email complete in the app (and put the Gmail "complete" label on it).
  emailDone: function (b) {
    var id = String(b.thread || '');
    if (!id) throw new Error('Which email?');
    var gm = markEmailDone_(id, b.who, '');
    return Object.assign(emailsReply_(), { gmail: gm });
  },

  // Store the Anthropic API key (used only to read emails). Only a signed-in app can set it; it is never sent back.
  emailSetKey: function (b) {
    var k = String(b.key || '').trim();
    if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(k)) throw new Error('That does not look like an Anthropic API key (it starts with sk-ant-)');
    PropertiesService.getScriptProperties().setProperty('ANTHROPIC_KEY', k);
    return Object.assign(emailsReply_(), { saved: true });
  },

  // Past orders, newest first, filtered by time (ISO from/to), text (customer, staff name or order number)
  // and total (min/max). Orders from before prices were recorded are rebuilt from the Log, with no total.
  orders: function (b) {
    var all = allOrders_(sheets_());
    var from = b.from ? new Date(b.from).getTime() : -Infinity, to = b.to ? new Date(b.to).getTime() : Infinity;
    var q = String(b.q || '').trim().toLowerCase().replace(/^#/, '');
    var min = b.min === '' || b.min == null ? null : Number(b.min), max = b.max === '' || b.max == null ? null : Number(b.max);
    var out = all.filter(function (o) {
      var t = new Date(o.time).getTime();
      if (t < from || t > to) return false;
      if (q && String(o.order).toLowerCase() !== q && o.customer.toLowerCase().indexOf(q) < 0 && o.who.toLowerCase().indexOf(q) < 0) return false;
      if ((min != null || max != null) && o.total == null) return false;
      if (min != null && o.total < min) return false;
      if (max != null && o.total > max) return false;
      return true;
    });
    out.sort(function (a, c) { return new Date(c.time) - new Date(a.time); });
    var limit = Math.min(1000, Math.max(1, Number(b.limit) || 300));
    return { ok: true, count: out.length, orders: out.slice(0, limit) };
  },

  // Undo an order: put every card in it back into stock (logged "Reversed #N") and mark it reversed.
  reverse: function (b) {
    var who = clean_(b.who, 60);
    if (!who) throw new Error('Enter your name first');
    var want = String(b.order == null ? '' : b.order).trim().replace(/^#/, '');
    if (!want) throw new Error('Which order?');
    return withLock_(function (s) {
      var o = null, all = allOrders_(s);
      for (var i = 0; i < all.length; i++) if (String(all[i].order) === want) { o = all[i]; break; }
      if (!o) throw new Error('Order #' + want + ' was not found');
      if (o.reversed) throw new Error('Order #' + want + ' was already reversed');
      var now = new Date(), seq = lastSeq_(s.log), logs = [], back = [];
      o.items.forEach(function (x) {
        var key = x[0], n = Number(x[1]) || 0; if (!n) return;
        var parts = key.split('|'), row = findRow_(s.inv, key);
        var old = row ? s.inv.getRange(row, 1, 1, INV_HEAD.length).getValues()[0] : null;
        var it = { key: key, id: parts[0], finish: parts[1], name: x[3] || '', set: x[4] || '', setName: x[5] || '', cn: x[6] || '' };
        keep_(it, old);
        var cur = old ? Number(old[3]) || 0 : 0, qty = cur + n;
        var vals = [key, it.id, it.finish, qty, it.name, it.set, it.setName, it.cn, now, who];
        if (row) s.inv.getRange(row, 1, 1, vals.length).setValues([vals]); else s.inv.appendRow(vals);
        logs.push([++seq, now, who, 'Reversed #' + want, key, it.name, it.set, it.setName, it.cn, it.finish, n, qty]);
        back.push({ key: key, qty: qty, name: it.name, set: it.set, setName: it.setName, cn: it.cn });
      });
      if (logs.length) s.log.getRange(s.log.getLastRow() + 1, 1, logs.length, LOG_HEAD.length).setValues(logs);
      var ot = ordTab_();
      if (o.row) ot.getRange(o.row, 8, 1, 2).setValues([[now, who]]);
      else ot.appendRow([String(o.order), o.time ? new Date(o.time) : now, o.who, o.customer, '', o.cards, itemsJson_(o.items), now, who]);
      return { ok: true, seq: seq, order: o.order, items: back };
    });
  },

  // Most recent log entries, newest first.
  history: function (b) {
    var s = sheets_();
    var last = lastSeq_(s.log);
    var limit = Math.min(1000, Math.max(1, Number(b.limit) || 300));
    var n = Math.min(limit, last);
    if (!n) return { ok: true, entries: [] };
    var v = s.log.getRange(last - n + 2, 1, n, LOG_HEAD.length).getValues().reverse();
    return { ok: true, entries: v.map(function (r) {
      return { seq: r[0], time: r[1] instanceof Date ? r[1].toISOString() : String(r[1]), who: r[2], action: r[3], key: r[4], name: r[5], set: r[6], setName: r[7], cn: r[8], finish: r[9], change: r[10], qty: r[11] };
    }) };
  },

  // Stock counts for a few printings (the Scryfall extension asks for the cards on screen).
  lookup: function (b) {
    var want = {}, out = {};
    (b.keys || []).slice(0, 3000).forEach(function (k) { k = String(k).toLowerCase(); want[k] = 1; out[k] = 0; });
    var inv = sheets_().inv, n = inv.getLastRow() - 1;
    if (n > 0) {
      var v = inv.getRange(2, 1, n, 4).getValues();
      for (var i = 0; i < v.length; i++) if (want[v[i][0]]) out[v[i][0]] = Number(v[i][3]) || 0;
    }
    return { ok: true, qty: out };
  },

  // The Missing Cards list.
  missing: function () {
    var sh = missTab_(), n = sh.getLastRow() - 1;
    var rows = n > 0 ? sh.getRange(2, 1, n, MISS_HEAD.length).getValues() : [];
    return { ok: true, cards: rows.filter(function (r) { return r[0]; }).map(function (r) {
      return { oracle: String(r[0]), name: String(r[1]), id: String(r[2]), set: String(r[3]), setName: String(r[4]), cn: String(r[5]), added: r[6] instanceof Date ? r[6].toISOString() : String(r[6]), who: String(r[7]) };
    }) };
  },

  // Add a card to Missing Cards. A card already on the list is left as it is (no duplicates).
  missingAdd: function (b) {
    var who = clean_(b.who, 60);
    if (!who) throw new Error('Enter your name first');
    var oracle = String(b.oracle || '').trim().toLowerCase();
    var id = String(b.id || '').trim().toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(oracle) || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Bad card id');
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) throw new Error('The inventory is busy, try again');
    try {
      var sh = missTab_();
      if (findRow_(sh, oracle)) return { ok: true, already: true };
      sh.appendRow([oracle, clean_(b.name, 200), id, clean_(b.set, 12), clean_(b.setName, 120), clean_(b.cn, 20), new Date(), who]);
      return { ok: true, added: true };
    } finally { lock.releaseLock(); }
  },

  // Take a card off Missing Cards.
  missingRemove: function (b) {
    var oracle = String(b.oracle || '').trim().toLowerCase();
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) throw new Error('The inventory is busy, try again');
    try {
      var sh = missTab_(), row = findRow_(sh, oracle);
      if (row) sh.deleteRow(row);
      return { ok: true, removed: !!row };
    } finally { lock.releaseLock(); }
  },

  /* ----- the store account ----- */

  // Does a store profile exist yet? (The app shows "Create store profile" when not.)
  authStatus: function () { return { ok: true, hasAccount: !!acct_() }; },

  // First run only: create the store's username and password. Stores a salted hash, never the password itself.
  setup: function (b) {
    var user = clean_(b.username, 40), pw = String(b.password || '');
    if (user.length < 3) throw new Error('The username needs at least 3 characters');
    if (!pw.length) throw new Error('Enter a password');   // any password is allowed: any length, any characters
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) throw new Error('Busy, try again');
    try {
      if (acct_()) throw new Error('A store profile already exists. Sign in instead');
      var salt = Utilities.getUuid(), now = new Date();
      acctTab_().getRange(2, 1, 1, ACCT_HEAD.length).setValues([[user, salt, hash_(salt, pw), now, now]]);
      dropSessions_();
      return { ok: true, token: newSession_(), username: user };
    } finally { lock.releaseLock(); }
  },

  login: function (b) {
    var props = PropertiesService.getScriptProperties();
    var a = acct_();
    if (!a) return { ok: false, needLogin: true, setup: true, error: 'There is no store profile yet' };
    var f = {}; try { f = JSON.parse(props.getProperty('LOGIN_FAILS') || '{}'); } catch (e) { f = {}; }
    if (f.until && Date.now() < f.until) throw new Error('Too many wrong tries. Wait a few minutes and try again');
    var ok = String(b.username || '').trim().toLowerCase() === a.username.toLowerCase() && hash_(a.salt, String(b.password || '')) === a.hash;
    if (!ok) {
      f.n = (f.until ? 0 : Number(f.n) || 0) + 1; f.until = 0;
      if (f.n >= 10) { f.until = Date.now() + 15 * 60000; f.n = 0; }
      props.setProperty('LOGIN_FAILS', JSON.stringify(f));
      Utilities.sleep(700);
      throw new Error('Wrong username or password');
    }
    props.deleteProperty('LOGIN_FAILS');
    return { ok: true, token: newSession_(), username: a.username };
  },

  // Sign this device out.
  logout: function (b) {
    if (b.token) PropertiesService.getScriptProperties().deleteProperty(sessionKey_(b.token));
    return { ok: true };
  },

  // Change the password (needs the current one). Every other device is signed out; this one gets a fresh token.
  changePassword: function (b) {
    var a = acct_(), pw = String(b.newPassword || '');
    if (!a) throw new Error('There is no store profile');
    if (hash_(a.salt, String(b.password || '')) !== a.hash) throw new Error('The current password is wrong');
    if (!pw.length) throw new Error('Enter a new password');
    var salt = Utilities.getUuid();
    acctTab_().getRange(2, 2, 1, 2).setValues([[salt, hash_(salt, pw)]]);
    acctTab_().getRange(2, 5, 1, 1).setValues([[new Date()]]);
    dropSessions_();
    return { ok: true, token: newSession_(), username: a.username };
  },

};

/* ---------- customer want-list emails ---------- */
// Gmail threads labelled "lists" are read (whole thread, so replies to our checklist questions count) by Claude through the
// Anthropic API, and kept in the EmailOrders tab as To do. Done = labelled "complete" in Gmail, or completed in the app (which
// then puts the "complete" label on the thread). This code only reads mail and adds/removes labels: it never sends or drafts.
var EML = 'EmailOrders';
var EML_HEAD = ['thread', 'subject', 'from', 'received', 'status', 'checklist', 'missing', 'parsed', 'msg_count', 'updated', 'done_at', 'done_by'];
var LISTS_LABEL = 'lists', DONE_LABEL = 'complete';
var EMAIL_MODEL = 'claude-haiku-5-5';
var EMAIL_PROMPT = [
  'You read emails from customers of a Magic: The Gathering card store who send a want list (the cards they want to buy).',
  'You get one email thread: the customer\'s first email and any later messages, each marked FROM THE CUSTOMER or FROM THE STORE.',
  'Our store asks every customer for a checklist: their name, their budget (per card and/or overall), and whether foils are OK.',
  'Combine the whole thread. A later answer from the customer replaces an earlier one. Messages from the store only give context (the questions asked); never take facts from them except to understand a short reply like "yes" or "no".',
  'Reply with ONLY one JSON object, no other text, in exactly this shape:',
  '{"isWantList":true|false,"customer":string|null,"cards":[{"qty":number,"name":string,"set":string|null}],"perCardBudget":number|null,"overallBudget":number|null,"noBudget":true|false,"foils":"yes"|"no"|null,"notes":string|null}',
  'Rules:',
  '- customer: the customer\'s name as they gave it (a "name:" line, "for Jane", or their sign-off/signature). null if the message body never says it. Do not use an email address.',
  '- cards: every card wanted, one entry per card name, qty defaults to 1. Use the real Magic card name, fixing obvious typos only when you are sure. Put a set code or set name in "set" only if the customer named one for that card. Do not include basic lands unless the customer asked for them. Do not include things that are not cards (greetings, budgets, questions).',
  '- perCardBudget: the most they will pay for one card, in dollars (e.g. "no more than $2 a card" = 2). overallBudget: the most for the whole order. null when not stated.',
  '- noBudget: true only if the customer clearly says they have no budget limit.',
  '- foils: "yes" if foils are OK/wanted, "no" if they do not want foils, null if they never said.',
  '- notes: anything else the store should know (shipping, condition, deadlines), short. null if none.',
  '- Never guess. If something is not stated, use null.',
  '- isWantList is false if the thread has no list of cards at all.'
].join('\n');

function emlTab_() {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(EML);
  if (!sh) {
    sh = ss.insertSheet(EML);
    sh.getRange(1, 1, 1, EML_HEAD.length).setValues([EML_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange('G:H').setNumberFormat('@');
  }
  return sh;
}

function emlRows_(sh) {
  var n = sh.getLastRow() - 1, out = [];
  var v = n > 0 ? sh.getRange(2, 1, n, EML_HEAD.length).getValues() : [];
  v.forEach(function (r, i) {
    if (!r[0]) return;
    out.push({ row: i + 2, thread: String(r[0]), subject: String(r[1]), from: String(r[2]), received: r[3], status: String(r[4]), checklist: String(r[5]), missing: String(r[6]), parsed: String(r[7]), msgCount: Number(r[8]) || 0 });
  });
  return out;
}

function emailsReply_() {
  var props = PropertiesService.getScriptProperties();
  var list = emlRows_(emlTab_()).filter(function (r) { return r.status === 'todo'; }).map(function (r) {
    var data = null, missing = [];
    try { data = JSON.parse(r.parsed || 'null'); } catch (e) {}
    try { missing = JSON.parse(r.missing || '[]'); } catch (e) {}
    return { thread: r.thread, subject: r.subject, from: r.from, received: r.received instanceof Date ? r.received.toISOString() : String(r.received), checklist: r.checklist, missing: missing, data: data };
  });
  list.sort(function (a, b) { return String(b.received).localeCompare(String(a.received)); });
  return { ok: true, emails: list, hasKey: !!props.getProperty('ANTHROPIC_KEY'), lastSync: Number(props.getProperty('EMAIL_SYNC_AT')) || 0, syncError: props.getProperty('EMAIL_SYNC_ERR') || '' };
}

// The text sent to the AI: each message with who sent it, quoted earlier mail stripped.
function threadText_(t) {
  var me = '';
  try { me = String(Session.getEffectiveUser().getEmail()).toLowerCase(); } catch (e) {}
  var msgs = t.getMessages(), parts = [];
  msgs.forEach(function (m, i) {
    var from = m.getFrom(), mine = me && from.toLowerCase().indexOf(me) >= 0;
    var body = String(m.getPlainBody() || '').replace(/\r/g, '');
    body = body.replace(/\n\s*On [^\n]{5,200}\n?[^\n]{0,100}wrote:[\s\S]*$/, '').replace(/\n-{2,}\s*Original Message[\s\S]*$/i, '');
    body = body.split('\n').filter(function (l) { return l.charAt(0) !== '>'; }).join('\n').trim().slice(0, 8000);
    parts.push('--- Message ' + (i + 1) + ' of ' + msgs.length + ' | ' + (mine ? 'FROM THE STORE' : 'FROM THE CUSTOMER') + ' (' + from.replace(/<[^>]*>/g, '').trim() + ') | ' + m.getDate().toISOString() + '\n' + body);
  });
  var text = 'Subject: ' + t.getFirstMessageSubject() + '\n\n' + parts.join('\n\n');
  return text.length > 30000 ? text.slice(0, 10000) + '\n...\n' + text.slice(-20000) : text;
}

function askModel_(key, text) {
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: EMAIL_MODEL, max_tokens: 4000, system: EMAIL_PROMPT, messages: [{ role: 'user', content: text }] })
  });
  var code = res.getResponseCode(), body = res.getContentText();
  if (code !== 200) throw new Error('The AI service returned ' + code + ': ' + body.slice(0, 160));
  var j = JSON.parse(body), out = (j.content || []).map(function (c) { return c.text || ''; }).join('');
  var m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The AI reply was not understood');
  return JSON.parse(m[0]);
}

// Clean the AI's answer and decide the checklist status here in code (not by the AI):
// complete = a name, a foil answer, and a budget (per-card, overall, or "no budget") are all in the thread.
function emailData_(p) {
  var num = function (v) { var n = Number(v); return v == null || v === '' || !isFinite(n) || n < 0 ? null : Math.round(n * 100) / 100; };
  var cards = (Array.isArray(p.cards) ? p.cards : []).slice(0, 300).map(function (c) {
    return { qty: Math.min(999, Math.max(1, Math.round(Number(c && c.qty) || 1))), name: clean_(c && c.name, 120), set: clean_(c && c.set, 40) };
  }).filter(function (c) { return c.name; });
  var d = {
    isWantList: !!p.isWantList && cards.length > 0, customer: clean_(p.customer, 80), cards: cards,
    perCardBudget: num(p.perCardBudget), overallBudget: num(p.overallBudget), noBudget: p.noBudget === true,
    foils: p.foils === 'yes' || p.foils === 'no' ? p.foils : null, notes: clean_(p.notes, 400)
  };
  var missing = [];
  if (!d.customer) missing.push('name');
  if (d.perCardBudget == null && d.overallBudget == null && !d.noBudget) missing.push('budget');
  if (!d.foils) missing.push('foils');
  return { data: d, missing: missing, checklist: missing.length ? 'needed' : 'complete' };
}

function syncEmails_(cap) {
  var props = PropertiesService.getScriptProperties();
  var started = Number(props.getProperty('EMAIL_SYNC_RUN')) || 0;
  if (Date.now() - started < 4 * 60000) return;     // another sync is still running
  props.setProperty('EMAIL_SYNC_RUN', String(Date.now()));
  try {
    var key = props.getProperty('ANTHROPIC_KEY');
    var lists = GmailApp.getUserLabelByName(LISTS_LABEL);
    if (!lists) throw new Error('There is no Gmail label named "' + LISTS_LABEL + '"');
    var doneLabel = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
    var doneIds = {};
    doneLabel.getThreads(0, 150).forEach(function (t) { doneIds[t.getId()] = 1; });
    var sh = emlTab_(), byId = {};
    emlRows_(sh).forEach(function (r) { byId[r.thread] = r; });
    var seen = {}, parsed = 0, problem = '';
    var put = function (r, vals) { if (r) sh.getRange(r.row, 1, 1, EML_HEAD.length).setValues([vals]); else sh.appendRow(vals); };
    lists.getThreads(0, 60).forEach(function (t) {
      var id = t.getId(), r = byId[id], now = new Date();
      seen[id] = 1;
      if (r && r.status === 'done') return;
      if (doneIds[id]) {                              // labelled "complete" in Gmail
        put(r, [id, r ? r.subject : t.getFirstMessageSubject(), r ? r.from : '', r ? r.received : t.getLastMessageDate(), 'done', r ? r.checklist : '', r ? r.missing : '', r ? r.parsed : '', r ? r.msgCount : 0, now, now, 'Gmail']);
        return;
      }
      var n = t.getMessageCount();
      if (r && r.msgCount === n) return;              // nothing new in this thread
      if (parsed >= cap) return;
      if (!key) { problem = 'Add the Anthropic API key so emails can be read.'; return; }
      parsed++;
      var from = '', msgs = t.getMessages();
      for (var i = 0; i < msgs.length; i++) { var f = msgs[i].getFrom(); if (f.toLowerCase().indexOf(String(Session.getEffectiveUser().getEmail()).toLowerCase()) < 0) { from = f.replace(/<[^>]*>/g, '').trim(); break; } }
      try {
        var res = emailData_(askModel_(key, threadText_(t)));
        put(r, [id, t.getFirstMessageSubject(), from, t.getLastMessageDate(), 'todo', res.checklist, JSON.stringify(res.missing), JSON.stringify(res.data), n, now, '', '']);
      } catch (e) {
        problem = String(e.message || e);
        put(r, [id, t.getFirstMessageSubject(), from, t.getLastMessageDate(), 'todo', 'error', '[]', JSON.stringify({ error: problem }), 0, now, '', '']);
      }
    });
    // To do emails that Gmail no longer lists under "lists" (label removed, or older than the newest 60): check them directly.
    var checked = 0;
    Object.keys(byId).forEach(function (id) {
      var r = byId[id];
      if (r.status !== 'todo' || seen[id] || checked >= 15) return;
      checked++;
      try {
        var t = GmailApp.getThreadById(id), names = t ? t.getLabels().map(function (l) { return l.getName(); }) : [];
        if (!t || names.indexOf(DONE_LABEL) >= 0 || names.indexOf(LISTS_LABEL) < 0) {
          var now2 = new Date();
          sh.getRange(r.row, 5).setValue('done'); sh.getRange(r.row, 11, 1, 2).setValues([[now2, 'Gmail']]);
        }
      } catch (e) {}
    });
    props.setProperty('EMAIL_SYNC_AT', String(Date.now()));
    if (problem) props.setProperty('EMAIL_SYNC_ERR', problem); else props.deleteProperty('EMAIL_SYNC_ERR');
  } catch (e) {
    props.setProperty('EMAIL_SYNC_ERR', String(e.message || e));
  } finally { props.deleteProperty('EMAIL_SYNC_RUN'); }
}

// Mark an email done in the sheet and put the Gmail "complete" label on it. Returns 'ok' or what went wrong with Gmail.
function markEmailDone_(id, who, order) {
  var sh = emlTab_(), row = findRow_(sh, id), now = new Date(), gm = 'ok';
  if (row) { sh.getRange(row, 5).setValue('done'); sh.getRange(row, 11, 1, 2).setValues([[now, clean_(who, 60)]]); }
  else sh.appendRow([id, '', '', now, 'done', '', '', '', 0, now, now, clean_(who, 60)]);
  try {
    var t = GmailApp.getThreadById(id);
    if (t) t.addLabel(GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL)); else gm = 'The Gmail thread was not found';
  } catch (e) { gm = String(e.message || e); }
  return gm;
}

// Time-driven trigger (every 10 minutes).
function emailTimer_() { syncEmails_(10); }

// Run this once from the Apps Script editor (Run > setupEmail): Google asks to allow Gmail access, the labels are
// created if missing, and the 10-minute timer is installed.
function setupEmail() {
  if (!GmailApp.getUserLabelByName(LISTS_LABEL)) GmailApp.createLabel(LISTS_LABEL);
  if (!GmailApp.getUserLabelByName(DONE_LABEL)) GmailApp.createLabel(DONE_LABEL);
  emlTab_();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'emailTimer_') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('emailTimer_').timeBased().everyMinutes(10).create();
  return 'Email timer installed';
}

/* ---------- account helpers ---------- */

function acctTab_() {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(ACCT);
  if (!sh) {
    sh = ss.insertSheet(ACCT);
    sh.getRange(1, 1, 1, ACCT_HEAD.length).setValues([ACCT_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:C').setNumberFormat('@');
  }
  return sh;
}
function acct_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(ACCT);
  if (!sh || sh.getLastRow() < 2) return null;
  var r = sh.getRange(2, 1, 1, 3).getValues()[0];
  return r[0] && r[2] ? { username: String(r[0]), salt: String(r[1]), hash: String(r[2]) } : null;
}
function sha_(s) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function hash_(salt, pw) { var h = salt + ':' + pw; for (var i = 0; i < HASH_ROUNDS; i++) h = sha_(h + ':' + salt); return h; }

// One Script Property per device (S_<hash of its token>) holding when it was last used, so two devices signing
// in or being used at the same moment can never overwrite each other.
function sessionKey_(token) { return 'S_' + sha_('session:' + String(token)).replace(/[^A-Za-z0-9]/g, '').slice(0, 40); }
function newSession_() {
  var props = PropertiesService.getScriptProperties();
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty(sessionKey_(token), String(Date.now()));
  var keys = props.getKeys().filter(function (k) { return k.indexOf('S_') === 0; });
  if (keys.length > 300) {   // keep the 300 most recently used devices
    keys.map(function (k) { return [k, Number(props.getProperty(k)) || 0]; }).sort(function (a, b) { return a[1] - b[1]; })
      .slice(0, keys.length - 300).forEach(function (x) { props.deleteProperty(x[0]); });
  }
  return token;
}
function dropSessions_() {
  var props = PropertiesService.getScriptProperties();
  props.getKeys().forEach(function (k) { if (k.indexOf('S_') === 0) props.deleteProperty(k); });
}
// {user: username} for a signed-in app, {ext: true} for the Scryfall extension (limited actions), or null.
function authorize_(b) {
  var a = acct_();
  if (!a) return null;
  var props = PropertiesService.getScriptProperties();
  if (b.token) {
    var key = sessionKey_(b.token), v = Number(props.getProperty(key));
    if (v) {
      var now = Date.now();
      if (now - v > SESSION_IDLE_MS) props.deleteProperty(key);
      else { if (now - v > 12 * 3600000) props.setProperty(key, String(now)); return { user: a.username }; }
    }
  }
  // The extension carries a secret key of its own (only its hash is kept here, so the public code doesn't give it away).
  if (b.code && EXT_ACTIONS[b.action] && sha_('ext:' + String(b.code)) === EXT_KEY_HASH) return { ext: true };
  return null;
}

function missTab_() {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(MISS);
  if (!sh) {
    sh = ss.insertSheet(MISS);
    sh.getRange(1, 1, 1, MISS_HEAD.length).setValues([MISS_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange('F:F').setNumberFormat('@');
  }
  return sh;
}

function ordTab_() {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(ORD);
  if (!sh) {
    sh = ss.insertSheet(ORD);
    sh.getRange(1, 1, 1, ORD_HEAD.length).setValues([ORD_HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange('G:G').setNumberFormat('@');
  }
  return sh;
}

// A cell holds at most 50,000 characters; very large orders drop card names (the key is enough to restore stock).
function itemsJson_(rec) {
  var j = JSON.stringify(rec);
  return j.length < 49000 ? j : JSON.stringify(rec.map(function (x) { return [x[0], x[1], x[2]]; }));
}

// Orders from the Orders tab, plus older ones rebuilt from the Log ("Sold #N" rows; "Reversed #N" marks them undone).
function allOrders_(s) {
  var ot = ordTab_(), n = ot.getLastRow() - 1, out = [], seen = {};
  var iso = function (d) { return d instanceof Date ? d.toISOString() : String(d || ''); };
  var rows = n > 0 ? ot.getRange(2, 1, n, ORD_HEAD.length).getValues() : [];
  rows.forEach(function (r, i) {
    if (r[0] === '' || r[0] == null) return;
    var items = []; try { items = JSON.parse(r[6] || '[]'); } catch (e) {}
    var o = { order: String(r[0]), time: iso(r[1]), who: String(r[2]), customer: String(r[3]), total: r[4] === '' ? null : Number(r[4]), cards: Number(r[5]) || 0, items: items, reversed: r[7] ? iso(r[7]) : '', reversedBy: String(r[8] || ''), row: i + 2 };
    seen[o.order] = o; out.push(o);
  });
  var ln = lastSeq_(s.log);
  if (ln > 0) {
    var v = s.log.getRange(2, 1, ln, LOG_HEAD.length).getValues(), old = {}, undone = {};
    v.forEach(function (r) {
      var a = String(r[3]), m = a.match(/^Sold #(\S+)(?: \(Email: (.*)\))?$/);
      if (m) {
        if (seen[m[1]]) return;
        var o = old[m[1]] || (old[m[1]] = { order: m[1], time: iso(r[1]), who: String(r[2]), customer: m[2] || '', total: null, cards: 0, items: [], reversed: '', reversedBy: '', row: 0 });
        var k = -Number(r[10]) || 0; o.cards += k;
        o.items.push([String(r[4]), k, null, String(r[5]), String(r[6]), String(r[7]), String(r[8])]);
        return;
      }
      m = a.match(/^Reversed #(\S+)$/);
      if (m && !undone[m[1]]) undone[m[1]] = { time: iso(r[1]), who: String(r[2]) };
    });
    Object.keys(old).forEach(function (k) {
      if (undone[k]) { old[k].reversed = undone[k].time; old[k].reversedBy = undone[k].who; }
      out.push(old[k]);
    });
  }
  return out;
}

/* ---------- helpers ---------- */

function sheets_() {
  var ss = SpreadsheetApp.getActive();
  return { inv: tab_(ss, INV, INV_HEAD), log: tab_(ss, LOG, LOG_HEAD) };
}

function tab_(ss, name, head) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');           // keys stay plain text
    if (name === INV) sh.getRange('H:H').setNumberFormat('@'); // collector numbers like "001" or "12a"
    if (name === LOG) sh.getRange('E:E').setNumberFormat('@').getSheet().getRange('I:I').setNumberFormat('@');
  }
  return sh;
}

// Log rows are numbered 1, 2, 3... in order, so the newest number is the row count.
function lastSeq_(log) { return Math.max(0, log.getLastRow() - 1); }

function findRow_(sh, key) {
  if (sh.getLastRow() < 2) return 0;
  var hit = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(key).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function item_(b) {
  var id = String(b.id || '').trim().toLowerCase();
  var finish = String(b.finish || '').trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Bad card id');
  if (!FINISHES[finish]) throw new Error('Bad finish');
  var m = b.meta || {};
  return { key: id + '|' + finish, id: id, finish: finish, name: clean_(m.name, 200), set: clean_(m.set, 12), setName: clean_(m.setName, 120), cn: clean_(m.cn, 20) };
}

// Blank card details in a request never overwrite details already in the sheet.
function keep_(it, old) {
  if (!old) return;
  if (!it.name) it.name = old[4]; if (!it.set) it.set = old[5]; if (!it.setName) it.setName = old[6]; if (!it.cn) it.cn = old[7];
}

function clean_(v, max) {
  var s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;  // never let a name be read as a formula
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('The inventory is busy, try again');
  try { return fn(sheets_()); } finally { lock.releaseLock(); }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
