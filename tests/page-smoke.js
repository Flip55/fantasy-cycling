// Smoke test: run the page's render functions against the live mock server with a stub DOM.
// Requires: node tests/mock-server.js running on :8787
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let js = html.match(/<script>([\s\S]*)<\/script>/)[1].replace(/const API_URL = "[^"]*";/, 'const API_URL = "http://localhost:8787/api";');

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

async function seed() {
  const API = 'http://localhost:8787/api';
  const post = async b => (await fetch(API, { method: 'POST', body: JSON.stringify(b) })).json();
  const adm = await (await fetch('http://localhost:8787/__admin')).text();
  const st = await (await fetch(API + '?action=state')).json();
  if (st.players.some(p => p.name === 'Flip') && st.riders.some(r => r.owner)) { const pl = await (await fetch('http://localhost:8787/__players')).json(); globalThis.__flipToken = pl.find(p => p.name === 'Flip').token; return; }
  await post({ action: 'reset', adminToken: adm, confirm: 'RESET' });
  await post({ action: 'addPlayer', adminToken: adm, name: 'Flip' });
  await post({ action: 'addPlayer', adminToken: adm, name: 'Jan' });
  const players = await (await fetch('http://localhost:8787/__players')).json();
  const flip = players.find(p => p.name === 'Flip'), jan = players.find(p => p.name === 'Jan');
  await post({ action: 'importStartlist', adminToken: adm, text: 'EVENEPOEL Remco;Soudal Quick-Step\nLAMPAERT Yves;Soudal Quick-Step\nPOGAČAR Tadej;UAE Team Emirates - XRG\nAYUSO Juan;UAE Team Emirates - XRG' });
  await post({ action: 'openRound', adminToken: adm, deadline: 'za 20:00' });
  await post({ action: 'bid', token: flip.token, round: 1, bids: [{ rider_id: 'pogacar-tadej', amount: 60 }, { rider_id: 'evenepoel-remco', amount: 40 }] });
  await post({ action: 'bid', token: jan.token, round: 1, bids: [{ rider_id: 'pogacar-tadej', amount: 60 }, { rider_id: 'ayuso-juan', amount: 5 }] });
  await post({ action: 'closeRound', adminToken: adm });
  await post({ action: 'importResults', adminToken: adm, label: 'Etappe 1', text: '1\t11\tPOGACAR Tadej\t28\tUAE Team Emirates - XRG\t100\t40\n2\t1\tEVENEPOEL Remco\t26\tSoudal Quick-Step\t70\t30' });
  globalThis.__flipToken = flip.token;
}

(async () => {
  await seed();
  const anon = await globalThis.__run('');
  const h = anon.html;
  const must = (sel, txt) => { if (!(h[sel] || '').includes(txt)) { console.error('FAIL', sel, 'missing', txt, '\n', h[sel]?.slice(0, 400)); process.exit(1); } };
  must('#tab-stand', 'Klassement'); must('#tab-stand', 'Flip'); must('#tab-stand', 'Etappe 1');
  must('#tab-teams', 'EVENEPOEL Remco'); must('#tab-teams', '40M');
  must('#tab-veiling', 'Ronde 1'); must('#tab-veiling', 'ex aequo');
  must('#tab-renners', 'Renners'); must('#tab-regels', 'Spelregels'); must('#tab-admin', 'Notaris');
  const flip = await globalThis.__run(globalThis.__flipToken || '68TVR6');
  if (flip.S.me !== 'Flip') { console.error('login failed'); process.exit(1); }
  if (!flip.html['#meBox'].includes('60M over')) { console.error('budget not shown'); process.exit(1); }
  console.log('page smoke OK');
})().catch(e => { console.error(e); process.exit(1); });
