/**
 * Big Brother Comics card inventory: shared backend.
 *
 * Paste this into Extensions > Apps Script on the inventory Google Sheet, then
 * Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 *
 * Tabs (created automatically on first use):
 *   Inventory  one row per printing + finish, with the live quantity
 *   Log        every change: who, when, what, and the quantity afterwards
 *
 * Optional: to require a shared store code later, set a Script Property named
 * ACCESS_CODE (Project Settings > Script Properties). The app will then ask for it.
 */

var INV = 'Inventory';
var LOG = 'Log';
var INV_HEAD = ['key', 'scryfall_id', 'finish', 'qty', 'name', 'set', 'set_name', 'collector_number', 'updated', 'updated_by'];
var LOG_HEAD = ['seq', 'time', 'who', 'action', 'key', 'name', 'set', 'set_name', 'collector_number', 'finish', 'change', 'qty_after'];
var FINISHES = { nonfoil: 1, foil: 1, etched: 1 };

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

  // Changes made since log number `since` (by anyone), oldest first.
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
};

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
