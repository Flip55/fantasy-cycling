// Local mock of the Apps Script backend, backed by in-memory "sheets".
// node tests/mock-server.js  → http://localhost:8787  (serves index.html with API_URL patched)
const http = require('http');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

// --- fake SpreadsheetApp / LockService / ContentService ---
const sheets = {};
class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  appendRow(r) { this.rows.push(r.slice()); }
  setFrozenRows() {}
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(r => r.length)); }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; }
  getRange(r, c, nr, nc) { const s = this; return {
    setValue: v => { s.rows[r - 1][c - 1] = v; },
    setValues: vals => { vals.forEach((row, i) => { while (s.rows.length < r + i) s.rows.push([]); row.forEach((v, j) => { s.rows[r - 1 + i][c - 1 + j] = v; }); }); }
  }; }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  clearContents() { this.rows = []; }
}
const SpreadsheetApp = { getActiveSpreadsheet: () => ({
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = new Sheet(n)),
  getSheets: () => Object.values(sheets),
  deleteSheet: () => {}
}) };
const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
const ContentService = { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => t }) };
const Utilities = { formatDate: (d, tz, fmt) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  const H = String(Number(parts.hour) % 24);
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day).replace('HH', H.padStart(2, '0')).replace('H', H).replace('mm', parts.minute);
} };

const m = {};
new Function('module', 'require', 'SpreadsheetApp', 'LockService', 'ContentService', 'Utilities', src + '\nmodule.exports.setup=setup;module.exports.doGet=doGet;module.exports.doPost=doPost;module.exports.readConfig_=readConfig_;')(m, require, SpreadsheetApp, LockService, ContentService, Utilities);
m.exports.setup();
const adminToken = m.exports.readConfig_().adminToken;

const PORT = Number(process.env.PORT || 8787);
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/const API_URL = "[^"]*";/, `const API_URL = "http://localhost:${PORT}/api";`);

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api') {
    const send = out => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(out); };
    if (req.method === 'POST') {
      let body = ''; req.on('data', d => body += d); req.on('end', () => send(m.exports.doPost({ postData: { contents: body } })));
    } else send(m.exports.doGet({ parameter: Object.fromEntries(u.searchParams) }));
    return;
  }
  if (u.pathname === '/__admin') { res.end(adminToken); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
}).listen(PORT, () => console.log(`mock on http://localhost:${PORT}  admin token: ${adminToken}`));
