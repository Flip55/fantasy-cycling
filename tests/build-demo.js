// Builds demo.html: the real index.html with an in-page fake backend and sample data.
const fs = require('fs'), path = require('path');
const { parsePcsStartlist } = require('./startlist-parser.js');
const riders = parsePcsStartlist(fs.readFileSync(path.join(__dirname, 'startlist-sample.txt'), 'utf8'))
  .map(r => ({ id: r.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-'), name: r.name, team: r.team, owner: null, price: null, round: null, points: 0 }));
const byName = n => riders.find(r => r.name === n);

const players = ['Flip', 'Wout', 'Sander'];
// round 1 bids
const r1 = [
  ['Flip', 'MAGNIER Paul', 38], ['Wout', 'MAGNIER Paul', 38], ['Sander', 'MAGNIER Paul', 30],      // tie -> stays free
  ['Flip', 'PIDCOCK Tom', 25], ['Wout', 'PIDCOCK Tom', 31], ['Sander', 'PIDCOCK Tom', 20],
  ['Flip', 'KOOIJ Olav', 22], ['Sander', 'KOOIJ Olav', 18],
  ['Wout', 'GROVES Kaden', 15], ['Sander', 'GROVES Kaden', 24],
  ['Flip', 'DOUBLE Paul', 9], ['Flip', 'VAUQUELIN Kevin', 6],
  ['Wout', 'AYUSO Juan', 12], ['Sander', 'AYUSO Juan', 14],
  ['Sander', 'MEEUS Jordi', 8], ['Wout', 'JAKOBSEN Fabio', 4], ['Flip', 'SHEFFIELD Magnus', 1],
];
const r2 = [
  ['Flip', 'MAGNIER Paul', 45], ['Wout', 'MAGNIER Paul', 41],
  ['Wout', 'NARVAEZ Jhonatan', 7], ['Sander', 'NARVAEZ Jhonatan', 7],  // tie again
  ['Sander', 'MOLANO Juan Sebastian', 6], ['Flip', 'VAN GILS Maxim', 3], ['Wout', 'WIDAR Jarno', 5],
  ['Sander', 'POWLESS Neilson', 4], ['Wout', 'VERMEERSCH Florian', 2], ['Sander', 'CARR Simon', 1],
];
const bids = [];
const budget = { Flip: 100, Wout: 100, Sander: 100 };
function resolve(round, list) {
  const by = {};
  list.forEach(([p, n, a]) => { const r = byName(n); if (!r) throw new Error('unknown ' + n); bids.push({ round, player: p, rider_id: r.id, amount: a }); (by[r.id] = by[r.id] || []).push({ p, a }); });
  Object.keys(by).forEach(id => {
    const l = by[id], max = Math.max(...l.map(x => x.a)), top = l.filter(x => x.a === max);
    if (top.length === 1) { const r = riders.find(x => x.id === id); r.owner = top[0].p; r.price = max; r.round = round; budget[top[0].p] -= max; }
  });
}
resolve(1, r1); resolve(2, r2);

const base = {
  ok: true, me: null,
  config: { raceName: 'Tour of Guangxi 2026', budget: 100, maxRiders: 20, minBid: 1, rounds: 3, round: 3, roundOpen: true, deadline: 'ma 12/10 20:00' },
  players: players.map(n => ({ name: n, budgetLeft: budget[n] })),
  riders, bids, resultLabels: []
};
const after = JSON.parse(JSON.stringify(base));
after.config.roundOpen = false; after.config.deadline = '';
after.resultLabels = ['stage-1', 'stage-2'];
after.imports = [{ label: 'stage-1', name: 'Etappe 1', locked: true }, { label: 'stage-2', name: 'Etappe 2', locked: false }];
const pts = { 'MAGNIER Paul': [60, 60], 'KOOIJ Olav': [25, 25], 'GROVES Kaden': [10, 10], 'MEEUS Jordi': [5, 3], 'JAKOBSEN Fabio': [3, 5], 'MOLANO Juan Sebastian': [1, 1], 'DE KLEIJN Arvid': [1, 0], 'FRETIN Milan': [0, 1] };
after.riders.forEach(r => { const v = pts[r.name]; if (!v) return; r.points = v[0] + v[1]; r.byLabel = {}; if (v[0]) r.byLabel['stage-1'] = v[0]; if (v[1]) r.byLabel['stage-2'] = v[1]; });

let html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
html = html.replace(/const API_URL = "[^"]*";/, 'const API_URL = "demo";');
const fake = `
const DEMO = { open: ${JSON.stringify(base)}, after: ${JSON.stringify(after)} };
let demoMode = 'open';
async function api(params, post) {
  await new Promise(r => setTimeout(r, 150));
  const st = DEMO[demoMode];
  if (params.action === 'state') { const s = JSON.parse(JSON.stringify(st)); s.me = params.token ? 'Flip' : null; s.bids = s.bids.filter(b => b.round < 3 || b.player === 'Flip'); return s; }
  if (params.action === 'bid') { params.bids.forEach(b => st.bids.push({ round: 3, player: 'Flip', rider_id: b.rider_id, amount: b.amount })); return { ok: true, placed: params.bids.length }; }
  if (params.action === 'addPlayer') return { ok: true, name: params.name || 'Demo', token: 'K7Q2PX' };
  if (params.action === 'importStartlist') return { ok: true, parsed: 154, added: 0, sample: [] };
  if (params.action === 'importResults') return { ok: true, label: params.label || 'Etappe 3', matched: 41, unmatched: ['12\\t3\\tSOMEONE Else\\t24\\tOther Team\\t2'] };
  if (params.action === 'closeRound') { if (!st.config.roundOpen) throw new Error('Er is geen ronde open.'); const r3 = st.bids.filter(b => b.round === 3); const by = {}; r3.forEach(b => (by[b.rider_id] = by[b.rider_id] || []).push(b)); let sold = 0, ties = []; Object.keys(by).forEach(id => { const l = by[id], max = Math.max(...l.map(x => x.amount)), top = l.filter(x => x.amount === max); if (top.length === 1) { const r = st.riders.find(x => x.id === id); r.owner = top[0].player; r.price = max; r.round = 3; st.players.find(p => p.name === top[0].player).budgetLeft -= max; sold++; } else ties.push(id); }); st.config.roundOpen = false; st.config.deadline = ''; return { ok: true, round: 3, sold, ties }; }
  if (params.action === 'openRound') { st.config.roundOpen = true; st.config.deadline = params.deadline || ''; return { ok: true, round: st.config.round }; }
  if (params.action === 'setDeadline') { st.config.deadline = params.deadline || ''; return { ok: true }; }
  throw new Error('Dit is een demo: deze actie doet hier niets.');
}
document.addEventListener('DOMContentLoaded', () => {
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99;background:#fff;border:1px solid #d9480f;border-radius:8px;padding:6px 10px;font:600 12px Inter,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2)';
  bar.innerHTML = 'DEMO · <select id="demoSel"><option value="open">Veiling: ronde 3 open</option><option value="after">Na etappe 2</option></select>';
  document.body.appendChild(bar);
  bar.querySelector('select').onchange = e => { demoMode = e.target.value; load(); };
  localStorage.setItem('fc_token', 'DEMO12'); token = 'DEMO12'; load();
});
`;
html = html.replace(/async function api\(params, post = false\) \{[\s\S]*?\n\}\n/, fake);
html = html.replace('<title>Fantasy Cycling</title>', '<title>Fantasy Cycling demo</title>');
fs.writeFileSync(path.join(__dirname, '..', 'demo.html'), html);
console.log('demo.html written', riders.length, 'riders', bids.length, 'bids', budget);
