// End-to-end: fake PCS page -> bookmarklet -> site preview -> submit -> lock.
// Requires: node tests/mock-server.js running on :8787 (fresh instance).
const { chromium } = require('playwright');
const http = require('http');

const PCS_HTML = (seg) => `<!doctype html><html><head><title>Tour of Guangxi 2026 Stage 1 results</title></head><body>
<div class="resTab" style="display:none"><table class="results"><thead><tr><th>Rnk</th><th>Rider</th><th>Team</th><th>UCI</th></tr></thead><tbody>
<tr><td>1</td><td><a href="rider/someone-hidden">HIDDEN Rider</a></td><td>X</td><td>999</td></tr></tbody></table></div>
<div class="resTab"><table class="results"><thead><tr><th>Rnk</th><th>GC</th><th>BIB</th><th>Rider</th><th>Age</th><th>Team</th><th>UCI</th><th>Pnt</th><th>Time</th></tr></thead><tbody>
<tr><td>1</td><td>1</td><td>121</td><td><span class="flag"></span><a href="rider/paul-magnier"><span class="uppercase">MAGNIER</span> Paul</a></td><td>22</td><td><a href="team/x">Soudal Quick-Step</a></td><td>60</td><td>40</td><td>3:12:00</td></tr>
<tr><td>2</td><td>2</td><td>37</td><td><a href="rider/olav-kooij">KOOIJ Olav</a></td><td>25</td><td>Decathlon CMA CGM Team</td><td>25</td><td>30</td><td>,,</td></tr>
<tr><td>3</td><td>3</td><td>97</td><td><a href="rider/sam-welsford">WELSFORD Sam</a></td><td>30</td><td>Netcompany INEOS</td><td>10</td><td>20</td><td>,,</td></tr>
<tr><td>4</td><td>4</td><td>13</td><td><a href="rider/kaden-groves">GROVES Kaden</a></td><td>27</td><td>Alpecin - Premier Tech</td><td>5</td><td>10</td><td>,,</td></tr>
<tr><td>5</td><td>5</td><td>1</td><td><a href="rider/paul-double">DOUBLE Paul</a></td><td>29</td><td>Team Jayco AlUla</td><td></td><td></td><td>,,</td></tr>
</tbody></table></div></body></html>`;

(async () => {
  // fake PCS on :8790 with the real URL structure
  const pcs = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PCS_HTML(req.url)); }).listen(8790);
  const API = 'http://localhost:8787/api';
  const post = async (b) => (await fetch(API, { method: 'POST', body: JSON.stringify(b) })).json();
  const adm = await (await fetch('http://localhost:8787/__admin')).text();
  const flip = await post({ action: 'addPlayer', adminToken: adm, name: 'Flip' });
  const jan = await post({ action: 'addPlayer', adminToken: adm, name: 'Jan' });
  const fs = require('fs');
  const { parsePcsStartlist } = require('./startlist-parser.js');
  const sl = parsePcsStartlist(fs.readFileSync(__dirname + '/startlist-sample.txt', 'utf8')).map(r => r.name + ';' + r.team).join('\n') + '\nWELSFORD Sam;Netcompany INEOS';
  console.log('startlist', (await post({ action: 'importStartlist', adminToken: adm, text: sl })).added);

  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('dialog', d => { console.log('dialog:', d.message()); d.accept(); });

  // 1. log in on the site, grab bookmarklet
  await page.goto('http://localhost:8787/#resultaten');
  await page.waitForSelector('#tab-resultaten .card');
  await page.click('#showLogin');
  await page.selectOption('#loginName', 'Flip');
  await page.fill('#loginToken', flip.token);
  await page.click('#loginBtn');
  await page.waitForSelector('#bml');
  const bml = await page.getAttribute('#bml', 'href');
  if (!bml.startsWith('javascript:')) throw new Error('no bookmarklet');
  console.log('bookmarklet length', bml.length);

  // 2. on the fake PCS page, run the bookmarklet; it opens our site in a new tab
  const pcsPage = await ctx.newPage();
  await pcsPage.goto('http://localhost:8790/race/tour-of-guangxi/2026/stage-1');
  const [popup] = await Promise.all([ctx.waitForEvent('page'), pcsPage.evaluate(bml.slice('javascript:'.length))]);
  await popup.waitForSelector('#importCard');
  const preview = await popup.innerText('#importCard');
  if (!/stage-1/.test(preview) || !/MAGNIER Paul/.test(preview) || /HIDDEN/.test(preview)) throw new Error('preview wrong:\n' + preview);
  if (/DOUBLE Paul/.test(preview)) throw new Error('rider without points should not be listed');
  console.log('preview OK');

  // 3. send
  await popup.click('#sendImport');
  await popup.waitForSelector('.msg.ok');
  console.log('sent:', (await popup.innerText('.msg.ok')).split('\n')[0]);
  const st = await (await fetch(API + '?action=state')).json();
  const pts = Object.fromEntries(st.riders.filter(r => r.points).map(r => [r.name, r.points]));
  if (pts['MAGNIER Paul'] !== 60 || pts['WELSFORD Sam'] !== 10 || pts['KOOIJ Olav'] !== 25) throw new Error('points wrong ' + JSON.stringify(pts));
  if (st.imports[0].label !== 'stage-1' || st.imports[0].by !== 'Flip') throw new Error('imports log wrong');
  console.log('points OK, locked =', st.imports[0].locked);

  // 4. intermediate GC page refused; other race refused
  const bad = await post({ action: 'submitResults', token: jan.token, url: 'https://www.procyclingstats.com/race/tour-of-guangxi/2026/stage-1-gc', rows: [{ name: 'MAGNIER Paul', uci: 5 }] });
  if (bad.ok || !/tussenstand/i.test(bad.error)) throw new Error('intermediate not refused: ' + JSON.stringify(bad));
  const other = await post({ action: 'submitResults', token: jan.token, url: 'https://www.procyclingstats.com/race/il-lombardia/2026/result', rows: [{ name: 'MAGNIER Paul', uci: 5 }] });
  if (other.ok) throw new Error('other race accepted');
  console.log('refusals OK');

  // 5. re-import by another player replaces (before lock), paste fallback works
  const re = await post({ action: 'submitResults', token: jan.token, url: 'https://www.procyclingstats.com/race/tour-of-guangxi/2026/stage-1', rows: [{ name: 'MAGNIER Paul', uci: 60 }, { name: 'KOOIJ Olav', uci: 30 }] });
  const st2 = await (await fetch(API + '?action=state')).json();
  const k = st2.riders.find(r => r.name === 'KOOIJ Olav').points;
  const nowBx = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', hour: '2-digit', hour12: false }).format(new Date())) % 24;
  if (nowBx < 22) { if (!re.ok || k !== 30 || st2.imports[0].by !== 'Jan') throw new Error('replace failed ' + JSON.stringify(re)); console.log('replace before lock OK'); }
  else { if (re.ok) throw new Error('should be locked after 22h'); console.log('lock after 22h OK'); }
  const paste = await post({ action: 'submitResults', token: jan.token, label: 'Etappe 2', text: 'Rnk\tRider\tTeam\tUCI\n1\tGROVES Kaden\tAlpecin - Premier Tech\t60' });
  if (!paste.ok || paste.label !== 'stage-2') throw new Error('paste failed ' + JSON.stringify(paste));
  console.log('paste fallback OK');

  // 6. admin override + delete
  const ov = await post({ action: 'importResults', adminToken: adm, label: 'stage-1', text: 'MAGNIER Paul;61' });
  if (!ov.ok) throw new Error('admin override failed');
  const del = await post({ action: 'deleteResults', adminToken: adm, label: 'Etappe 2' });
  const st3 = await (await fetch(API + '?action=state')).json();
  if (st3.imports.some(i => i.label === 'stage-2') || st3.riders.find(r => r.name === 'MAGNIER Paul').points !== 61) throw new Error('admin ops wrong');
  console.log('admin override/delete OK');

  // 7. Resultaten tab renders status
  await page.reload(); await page.click('[data-tab=resultaten]');
  const tab = await page.innerText('#tab-resultaten');
  if (!/Etappe 1[\s\S]*door admin/.test(tab) || !/Etappe 2[\s\S]*nog niet/.test(tab)) throw new Error('status table wrong:\n' + tab.slice(0, 600));
  console.log('status tab OK');

  await browser.close(); pcs.close();
  console.log('E2E OK');
})().catch(e => { console.error(e); process.exit(1); });
