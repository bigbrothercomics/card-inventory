// Runs apps-script/Code.gs unchanged against an in-memory imitation of Google Sheets, served over HTTP.
const http = require('http'), fs = require('fs'), vm = require('vm');
class Range {
  constructor(sh, r, c, nr = 1, nc = 1) { Object.assign(this, { sh, r, c, nr, nc }); }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = this.sh.rows[this.r - 1 + i] || []; out.push(Array.from({ length: this.nc }, (_, j) => row[this.c - 1 + j] ?? '')); } return out; }
  getValue() { return this.getValues()[0][0]; }
  setValues(v) { if (v.length !== this.nr || v[0].length !== this.nc) throw new Error(`setValues size mismatch ${v.length}x${v[0].length} vs ${this.nr}x${this.nc}`); v.forEach((row, i) => { const R = this.sh.rows[this.r - 1 + i] ||= []; row.forEach((x, j) => R[this.c - 1 + j] = x); }); return this; }
  setFontWeight() { return this; } setNumberFormat() { return this; } getSheet() { return this.sh; }
  createTextFinder(t) { const self = this; return { matchEntireCell() { return this; }, findNext() { const v = self.getValues(); for (let i = 0; i < v.length; i++) for (let j = 0; j < v[i].length; j++) if (String(v[i][j]) === t) return { getRow: () => self.r + i }; return null; } }; }
}
class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  getLastRow() { for (let i = this.rows.length; i > 0; i--) if ((this.rows[i - 1] || []).some(x => x !== '' && x != null)) return i; return 0; }
  getRange(a, b, c, d) { if (typeof a === 'string') return new Range(this, 1, 1); return new Range(this, a, b, c, d); }
  appendRow(v) { this.rows[this.getLastRow()] = v.slice(); }
  setFrozenRows() {}
}
const ss = { tabs: {}, getSheetByName(n) { return this.tabs[n] || null; }, insertSheet(n) { return this.tabs[n] = new Sheet(n); } };
const props = {};
const ctx = {
  SpreadsheetApp: { getActive: () => ss },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
  console,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx);
http.createServer((req, res) => {
  const hdr = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.url.startsWith('/__setcode')) { props.ACCESS_CODE = new URL(req.url, 'http://x').searchParams.get('c') || null; res.writeHead(200, hdr); return res.end('{}'); }
  if (req.url.startsWith('/__dump')) { res.writeHead(200, hdr); return res.end(JSON.stringify(Object.fromEntries(Object.entries(ss.tabs).map(([k, v]) => [k, v.rows])))); }
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const out = req.method === 'POST' ? ctx.doPost({ postData: { contents: b } }) : ctx.doGet();
    setTimeout(() => { res.writeHead(200, hdr); res.end(out.s); }, 300); // Apps Script is slow; imitate some delay
  });
}).listen(8091, () => console.log('mock Apps Script on :8091'));
