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
 * Optional: to require a shared store code later, set a Script Property named
 * ACCESS_CODE (Project Settings > Script Properties). The app will then ask for it.
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

function doGet() {
  return json_({ ok: true, service: 'card-inventory', time: new Date().toISOString() });
}

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  try {
    var code = PropertiesService.getScriptProperties().getProperty('ACCESS_CODE');
    if (code && String(body.code || '') !== code) return json_({ ok: false, error: 'Wrong store code', needCode: true });
    var fn = ACTIONS[body.action];
    if (!fn) return json_({ ok: false, error: 'Unknown action' });
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
      return { ok: true, seq: seq, order: order, items: items, customerN: customerN };
    });
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
};

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
