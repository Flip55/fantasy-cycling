// Smoke test: run the page's render functions against the live mock server with a stub DOM.
// Requires: node tests/mock-server.js running on :8787
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let js = html.match(/<script>([\s\S]*)<\/script>/)[1].replace('const API_URL = "";', 'const API_URL = "http://localhost:8787/api";');

function el() {
  const e = { innerHTML: '', textContent: '', value: '', hidden: false, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [], querySelector: () => el() };
  return e;
}
const elems = {};
const document = {
  querySelector: s => elems[s] || (elems[s] = el()),
  querySelectorAll: () => [],
  visibilityState: 'visible'
};
const localStorage = { s: {}, getItem(k) { return this.s[k] ?? null; }, setItem(k, v) { this.s[k] = v; }, removeItem(k) { delete this.s[k]; } };
const location = { hash: '' };
const sandbox = { document, localStorage, location, fetch, setInterval: () => 0, confirm: () => true, prompt: () => 'RESET', URLSearchParams, console };
js += '\n;globalThis.__run = async (tok) => { token = tok; await load(); return { S, html: Object.fromEntries(Object.entries(document.__elems).map(([k,v])=>[k,v.innerHTML])) }; };';
document.__elems = elems;
new Function(...Object.keys(sandbox), js)(...Object.values(sandbox));

(async () => {
  const anon = await globalThis.__run('');
  const h = anon.html;
  const must = (sel, txt) => { if (!(h[sel] || '').includes(txt)) { console.error('FAIL', sel, 'missing', txt, '\n', h[sel]?.slice(0, 400)); process.exit(1); } };
  must('#tab-stand', 'Klassement'); must('#tab-stand', 'Flip'); must('#tab-stand', 'Etappe 1');
  must('#tab-teams', 'EVENEPOEL Remco'); must('#tab-teams', '40M');
  must('#tab-veiling', 'Ronde 1'); must('#tab-veiling', 'ex aequo');
  must('#tab-renners', 'Renners'); must('#tab-regels', 'Spelregels'); must('#tab-admin', 'Notaris');
  const flip = await globalThis.__run('68TVR6');
  if (flip.S.me !== 'Flip') { console.error('login failed'); process.exit(1); }
  if (!flip.html['#meBox'].includes('60M over')) { console.error('budget not shown'); process.exit(1); }
  console.log('page smoke OK');
})().catch(e => { console.error(e); process.exit(1); });
