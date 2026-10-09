/**
 * Fantasy Cycling – Google Apps Script backend
 * ---------------------------------------------
 * Bound to one Google Sheet. Deploy as Web App:
 *   Deploy > New deployment > Web app
 *   Execute as: Me   /   Who has access: Anyone
 * Then paste the web-app URL into index.html (API_URL).
 *
 * First run: open the script editor, pick the function "setup" and run it once.
 * It creates all tabs and prints the admin token in the Config tab.
 */

var TABS = {
  config:  'Config',
  players: 'Players',
  riders:  'Riders',
  bids:    'Bids',
  results: 'Results',
  log:     'Log'
};

var HEADERS = {
  Config:  ['key', 'value'],
  Players: ['name', 'token', 'budget_left'],
  Riders:  ['id', 'name', 'team', 'owner', 'price', 'round'],
  Bids:    ['round', 'player', 'rider_id', 'amount', 'timestamp'],
  Results: ['label', 'rider_id', 'points', 'timestamp'],
  Log:     ['timestamp', 'who', 'what']
};

var DEFAULT_CONFIG = {
  raceName:   'Tour of Guangxi 2026',
  budget:     100,
  maxRiders:  20,
  minBid:     1,
  rounds:     3,
  round:      0,       // 0 = auction not started yet
  roundOpen:  'false', // 'true' while a round accepts bids
  deadline:   '',      // free text shown to players, e.g. "za 11/10 20:00"
  adminToken: ''       // filled by setup()
};

/* ------------------------------------------------------------------ */
/*  Setup                                                              */
/* ------------------------------------------------------------------ */

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (k) {
    var name = TABS[k];
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.appendRow(HEADERS[name]);
      sh.setFrozenRows(1);
    }
  });
  var cfg = readConfig_();
  Object.keys(DEFAULT_CONFIG).forEach(function (k) {
    if (cfg[k] === undefined) setConfig_(k, DEFAULT_CONFIG[k]);
  });
  if (!readConfig_().adminToken) setConfig_('adminToken', makeToken_(10));
  // Remove the default "Sheet1" if it is empty
  var s1 = ss.getSheetByName('Sheet1') || ss.getSheetByName('Blad1');
  if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
  log_('system', 'setup done');
}

/* ------------------------------------------------------------------ */
/*  HTTP entry points                                                  */
/* ------------------------------------------------------------------ */

function doGet(e) {
  var p = (e && e.parameter) || {};
  return respond_(handle_(p.action, p));
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  return respond_(handle_(body.action, body));
}

function respond_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle_(action, p) {
  try {
    switch (action) {
      case 'state':           return getState_(p);
      case 'bid':             return placeBids_(p);
      // admin
      case 'addPlayer':       return admin_(p, addPlayer_);
      case 'openRound':       return admin_(p, openRound_);
      case 'closeRound':      return admin_(p, closeRound_);
      case 'setDeadline':     return admin_(p, setDeadline_);
      case 'importStartlist': return admin_(p, importStartlist_);
      case 'importResults':   return admin_(p, importResults_);
      case 'deleteResults':   return admin_(p, deleteResults_);
      case 'reset':           return admin_(p, reset_);
      default: return { ok: false, error: 'unknown action' };
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function admin_(p, fn) {
  var cfg = readConfig_();
  if (!p.adminToken || p.adminToken !== cfg.adminToken) {
    return { ok: false, error: 'admin token onjuist' };
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(p, cfg); } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------------ */
/*  Public: state                                                      */
/* ------------------------------------------------------------------ */

function getState_(p) {
  var cfg = readConfig_();
  var players = readRows_(TABS.players);
  var riders = readRows_(TABS.riders);
  var bids = readRows_(TABS.bids);
  var results = readRows_(TABS.results);
  var round = Number(cfg.round);
  var roundOpen = cfg.roundOpen === 'true';

  var pointsByRider = {};
  results.forEach(function (r) {
    pointsByRider[r.rider_id] = (pointsByRider[r.rider_id] || 0) + Number(r.points);
  });

  // identify caller (optional)
  var me = null;
  if (p.token) {
    var pl = players.filter(function (x) { return x.token === p.token; })[0];
    if (pl) me = pl.name;
  }

  var publicBids = bids
    .filter(function (b) {
      var r = Number(b.round);
      // bids of closed rounds are public; bids of the open round only for yourself
      return r < round || (r === round && !roundOpen) || (me && b.player === me);
    })
    .map(function (b) {
      return { round: Number(b.round), player: b.player, rider_id: b.rider_id, amount: Number(b.amount) };
    });

  return {
    ok: true,
    me: me,
    config: {
      raceName: cfg.raceName,
      budget: Number(cfg.budget),
      maxRiders: Number(cfg.maxRiders),
      minBid: Number(cfg.minBid),
      rounds: Number(cfg.rounds),
      round: round,
      roundOpen: roundOpen,
      deadline: cfg.deadline
    },
    players: players.map(function (x) {
      return { name: x.name, budgetLeft: Number(x.budget_left) };
    }),
    riders: riders.map(function (r) {
      return {
        id: r.id, name: r.name, team: r.team,
        owner: r.owner || null,
        price: r.price === '' ? null : Number(r.price),
        round: r.round === '' ? null : Number(r.round),
        points: pointsByRider[r.id] || 0
      };
    }),
    bids: publicBids,
    resultLabels: uniq_(results.map(function (r) { return r.label; }))
  };
}

/* ------------------------------------------------------------------ */
/*  Public: place bids                                                 */
/* ------------------------------------------------------------------ */

/**
 * p = { token, round, bids: [{rider_id, amount}, ...] }
 * Bids are final: once placed on a rider they cannot be changed or removed.
 * Rules enforced:
 *  - round must be open and match
 *  - amount is a whole number >= minBid
 *  - rider must be free and not already bid on by this player in this round
 *  - sum of all bids in this round <= budget_left
 *  - riders owned + bids this round <= maxRiders
 */
function placeBids_(p) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var cfg = readConfig_();
    var round = Number(cfg.round);
    if (cfg.roundOpen !== 'true') return { ok: false, error: 'Er is geen ronde open.' };
    if (Number(p.round) !== round) return { ok: false, error: 'Verkeerde ronde, herlaad de pagina.' };

    var players = readRows_(TABS.players);
    var me = players.filter(function (x) { return x.token === p.token; })[0];
    if (!me) return { ok: false, error: 'Onbekende speler/code.' };

    var riders = readRows_(TABS.riders);
    var riderById = {};
    riders.forEach(function (r) { riderById[r.id] = r; });

    var allBids = readRows_(TABS.bids);
    var myBids = allBids.filter(function (b) { return b.player === me.name && Number(b.round) === round; });
    var myOwned = riders.filter(function (r) { return r.owner === me.name; }).length;

    var check = validateBids_(p.bids, {
      minBid: Number(cfg.minBid),
      maxRiders: Number(cfg.maxRiders),
      budgetLeft: Number(me.budget_left),
      ownedCount: myOwned,
      existingBids: myBids,
      riderById: riderById
    });
    if (!check.ok) return check;

    var sh = sheet_(TABS.bids);
    var now = new Date().toISOString();
    check.bids.forEach(function (b) {
      sh.appendRow([round, me.name, b.rider_id, b.amount, now]);
    });
    log_(me.name, 'bod ronde ' + round + ': ' + check.bids.map(function (b) { return b.rider_id + '=' + b.amount; }).join(', '));
    return { ok: true, placed: check.bids.length };
  } finally {
    lock.releaseLock();
  }
}

/** Pure validation, testable outside Apps Script. */
function validateBids_(newBids, ctx) {
  if (!Array.isArray(newBids) || newBids.length === 0) return { ok: false, error: 'Geen biedingen.' };
  var seen = {};
  var clean = [];
  for (var i = 0; i < newBids.length; i++) {
    var b = newBids[i];
    var amount = Number(b.amount);
    var rider = ctx.riderById[b.rider_id];
    if (!rider) return { ok: false, error: 'Onbekende renner: ' + b.rider_id };
    if (!Number.isInteger(amount) || amount < ctx.minBid) {
      return { ok: false, error: 'Bod op ' + rider.name + ' moet een geheel getal >= ' + ctx.minBid + ' zijn.' };
    }
    if (rider.owner) return { ok: false, error: rider.name + ' is al verkocht.' };
    if (seen[b.rider_id]) return { ok: false, error: 'Dubbel bod op ' + rider.name + '.' };
    seen[b.rider_id] = true;
    var already = ctx.existingBids.some(function (e) { return e.rider_id === b.rider_id; });
    if (already) return { ok: false, error: 'Je hebt al geboden op ' + rider.name + ' (bod kan niet gewijzigd worden).' };
    clean.push({ rider_id: b.rider_id, amount: amount });
  }
  var existingTotal = ctx.existingBids.reduce(function (s, e) { return s + Number(e.amount); }, 0);
  var newTotal = clean.reduce(function (s, e) { return s + e.amount; }, 0);
  if (existingTotal + newTotal > ctx.budgetLeft) {
    return { ok: false, error: 'Totaal van je biedingen deze ronde (' + (existingTotal + newTotal) + 'M) overschrijdt je budget (' + ctx.budgetLeft + 'M).' };
  }
  if (ctx.ownedCount + ctx.existingBids.length + clean.length > ctx.maxRiders) {
    return { ok: false, error: 'Max ' + ctx.maxRiders + ' renners (gekocht + biedingen deze ronde).' };
  }
  return { ok: true, bids: clean };
}

/* ------------------------------------------------------------------ */
/*  Admin                                                              */
/* ------------------------------------------------------------------ */

function addPlayer_(p, cfg) {
  var name = String(p.name || '').trim();
  if (!name) return { ok: false, error: 'naam ontbreekt' };
  var players = readRows_(TABS.players);
  if (players.some(function (x) { return x.name.toLowerCase() === name.toLowerCase(); })) {
    return { ok: false, error: 'speler bestaat al' };
  }
  var token = makeToken_(6);
  sheet_(TABS.players).appendRow([name, token, Number(cfg.budget)]);
  log_('admin', 'speler toegevoegd: ' + name);
  return { ok: true, name: name, token: token };
}

function setDeadline_(p) {
  setConfig_('deadline', String(p.deadline || ''));
  return { ok: true };
}

function openRound_(p, cfg) {
  if (cfg.roundOpen === 'true') return { ok: false, error: 'Er is al een ronde open.' };
  var round = Number(cfg.round);
  if (round >= Number(cfg.rounds)) return { ok: false, error: 'Alle rondes zijn gespeeld.' };
  var riders = readRows_(TABS.riders);
  if (riders.length === 0) return { ok: false, error: 'Importeer eerst de startlijst.' };
  setConfig_('round', round + 1);
  setConfig_('roundOpen', 'true');
  if (p.deadline !== undefined) setConfig_('deadline', String(p.deadline));
  log_('admin', 'ronde ' + (round + 1) + ' geopend');
  return { ok: true, round: round + 1 };
}

function closeRound_(p, cfg) {
  if (cfg.roundOpen !== 'true') return { ok: false, error: 'Er is geen ronde open.' };
  var round = Number(cfg.round);
  var riders = readRows_(TABS.riders);
  var players = readRows_(TABS.players);
  var bids = readRows_(TABS.bids).filter(function (b) { return Number(b.round) === round; });

  var outcome = resolveRound_(bids);

  // write riders
  var rsh = sheet_(TABS.riders);
  var rvals = rsh.getDataRange().getValues();
  var ownerCol = HEADERS.Riders.indexOf('owner'), priceCol = HEADERS.Riders.indexOf('price'), roundCol = HEADERS.Riders.indexOf('round');
  var spent = {};
  for (var i = 1; i < rvals.length; i++) {
    var id = String(rvals[i][0]);
    var w = outcome.winners[id];
    if (w && !rvals[i][ownerCol]) {
      rvals[i][ownerCol] = w.player;
      rvals[i][priceCol] = w.amount;
      rvals[i][roundCol] = round;
      spent[w.player] = (spent[w.player] || 0) + w.amount;
    }
  }
  rsh.getRange(1, 1, rvals.length, rvals[0].length).setValues(rvals);

  // write budgets
  var psh = sheet_(TABS.players);
  var pvals = psh.getDataRange().getValues();
  var bCol = HEADERS.Players.indexOf('budget_left');
  for (var j = 1; j < pvals.length; j++) {
    var nm = String(pvals[j][0]);
    if (spent[nm]) pvals[j][bCol] = Number(pvals[j][bCol]) - spent[nm];
  }
  psh.getRange(1, 1, pvals.length, pvals[0].length).setValues(pvals);

  setConfig_('roundOpen', 'false');
  setConfig_('deadline', '');
  log_('admin', 'ronde ' + round + ' gesloten: ' + Object.keys(outcome.winners).length + ' verkocht, ' + outcome.ties.length + ' ex aequo');
  return { ok: true, round: round, sold: Object.keys(outcome.winners).length, ties: outcome.ties };
}

/**
 * Pure: highest bid wins; a tie for the highest bid means nobody gets the rider.
 * Returns { winners: {rider_id: {player, amount}}, ties: [rider_id] }
 */
function resolveRound_(bids) {
  var byRider = {};
  bids.forEach(function (b) {
    (byRider[b.rider_id] = byRider[b.rider_id] || []).push({ player: b.player, amount: Number(b.amount) });
  });
  var winners = {}, ties = [];
  Object.keys(byRider).forEach(function (id) {
    var list = byRider[id];
    var max = Math.max.apply(null, list.map(function (x) { return x.amount; }));
    var top = list.filter(function (x) { return x.amount === max; });
    if (top.length === 1) winners[id] = top[0];
    else ties.push(id);
  });
  return { winners: winners, ties: ties };
}

/* ------------------------------------------------------------------ */
/*  Admin: startlist import                                            */
/* ------------------------------------------------------------------ */

/**
 * p.text = text copied from the PCS startlist page (or "name;team" lines).
 * Riders already present (same normalised name) are kept.
 */
function importStartlist_(p) {
  var parsed = parseStartlist_(String(p.text || ''));
  if (parsed.length === 0) return { ok: false, error: 'Geen renners herkend in de tekst.' };
  var existing = readRows_(TABS.riders);
  var known = {};
  existing.forEach(function (r) { known[normName_(r.name)] = true; });
  var sh = sheet_(TABS.riders);
  var added = 0;
  parsed.forEach(function (r) {
    var key = normName_(r.name);
    if (known[key]) return;
    known[key] = true;
    sh.appendRow([slug_(r.name), r.name, r.team, '', '', '']);
    added++;
  });
  log_('admin', 'startlijst import: ' + added + ' nieuw');
  return { ok: true, parsed: parsed.length, added: added, sample: parsed.slice(0, 5) };
}

/**
 * Pure. Accepts:
 *   - PCS startlist copy/paste: team name lines followed by "123 SURNAME Firstname" lines
 *   - simple lines "SURNAME Firstname;Team" or "SURNAME Firstname\tTeam"
 */
function parseStartlist_(text) {
  var out = [];
  var team = '';
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var m;
    if ((m = line.match(/^(.+?)\s*[;\t]\s*(.+)$/)) && !/^\d+$/.test(m[1]) && !/^\d+\s/.test(m[1])) {
      out.push({ name: cleanName_(m[1]), team: m[2].trim() });
      continue;
    }
    if ((m = line.match(/^\d{1,3}\s+(.+)$/))) {
      var name = m[1].replace(/\s+\d+$/, '').trim(); // trailing numbers (age etc.)
      name = name.replace(/\s+(DNS|DNF|OTL|DSQ)$/i, '');
      if (looksLikeRiderName_(name)) { out.push({ name: cleanName_(name), team: team }); continue; }
    }
    // otherwise treat as a team header (PCS prints team names between rider blocks)
    if (!/^(rider|team|bib|#|startlist|age|rnk|nr|no\.?)$/i.test(line) && line.length < 60) team = line.replace(/\s*\(.*\)\s*$/, '').trim();
  }
  return out;
}

function looksLikeRiderName_(s) {
  // PCS style: at least one UPPERCASE word (surname) and one capitalised word
  return /[A-ZÀ-Ž]{2,}/.test(s) && /\s/.test(s);
}

function cleanName_(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/*  Admin: results import                                              */
/* ------------------------------------------------------------------ */

/**
 * p.label = e.g. "Etappe 1"  (unique per import; re-importing a label replaces it)
 * p.text  = copy/paste of the PCS result table (columns incl. Rider, Team, UCI)
 *           or simple lines "SURNAME Firstname;points"
 */
function importResults_(p) {
  var label = String(p.label || '').trim();
  if (!label) return { ok: false, error: 'label ontbreekt (bv. "Etappe 1")' };
  var riders = readRows_(TABS.riders);
  var parsed = parseResults_(String(p.text || ''), riders);
  if (parsed.matched.length === 0) return { ok: false, error: 'Geen renners met punten herkend.' };

  deleteLabel_(label);
  var sh = sheet_(TABS.results);
  var now = new Date().toISOString();
  parsed.matched.forEach(function (m) { sh.appendRow([label, m.rider_id, m.points, now]); });
  log_('admin', 'resultaten "' + label + '": ' + parsed.matched.length + ' renners');
  return { ok: true, label: label, matched: parsed.matched.length, unmatched: parsed.unmatched.slice(0, 30) };
}

function deleteResults_(p) {
  var label = String(p.label || '').trim();
  var n = deleteLabel_(label);
  log_('admin', 'resultaten verwijderd: "' + label + '" (' + n + ')');
  return { ok: true, removed: n };
}

function deleteLabel_(label) {
  var sh = sheet_(TABS.results);
  var vals = sh.getDataRange().getValues();
  var keep = [vals[0]];
  var removed = 0;
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === label) removed++; else keep.push(vals[i]);
  }
  if (removed) {
    sh.clearContents();
    sh.getRange(1, 1, keep.length, keep[0].length).setValues(keep);
  }
  return removed;
}

/**
 * Pure. For each line: find a known rider name, then take the UCI points:
 *  - if the line is "name;points" or "name<tab>points" -> that number
 *  - PCS table paste: the first integer after the rider's team name
 *    (falls back to the first integer after the name that is not the age).
 * Lines with 0 points are ignored.
 */
function parseResults_(text, riders) {
  var index = riders.map(function (r) {
    return { id: r.id, name: r.name, team: r.team, key: normName_(r.name), teamKey: normName_(r.team) };
  });
  var matched = [], unmatched = [];
  var seen = {};
  text.split(/\r?\n/).forEach(function (raw) {
    var line = raw.trim();
    if (!line) return;
    var nline = normName_(line);
    var hit = null, pos = -1;
    for (var i = 0; i < index.length; i++) {
      var k = index[i].key;
      var at = nline.indexOf(k);
      if (at >= 0 && (hit === null || k.length > hit.key.length)) { hit = index[i]; pos = at; }
    }
    if (!hit) {
      if (/\d/.test(line) && /[a-z]/i.test(line)) unmatched.push(line.slice(0, 60));
      return;
    }
    var rest = nline.slice(pos + hit.key.length);
    var points = null;
    var simple = rest.match(/^\s*[;,\t]\s*(\d+)\s*$/);
    if (simple) {
      points = Number(simple[1]);
    } else {
      var afterTeam = hit.teamKey && rest.indexOf(hit.teamKey) >= 0 ? rest.slice(rest.indexOf(hit.teamKey) + hit.teamKey.length) : null;
      var src = afterTeam !== null ? afterTeam : rest.replace(/^\s*\d{2}\s/, ' '); // drop age if no team found
      var num = src.match(/(\d+)/);
      if (num) points = Number(num[1]);
    }
    if (points === null || points <= 0) return;
    if (seen[hit.id]) return;
    seen[hit.id] = true;
    matched.push({ rider_id: hit.id, name: hit.name, points: points });
  });
  return { matched: matched, unmatched: unmatched };
}

/* ------------------------------------------------------------------ */
/*  Admin: reset (keeps players & riders, clears auction and results)  */
/* ------------------------------------------------------------------ */

function reset_(p, cfg) {
  if (p.confirm !== 'RESET') return { ok: false, error: 'bevestig met confirm: "RESET"' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [TABS.bids, TABS.results].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    sh.clearContents();
    sh.appendRow(HEADERS[n]);
  });
  var rsh = sheet_(TABS.riders);
  var rv = rsh.getDataRange().getValues();
  for (var i = 1; i < rv.length; i++) { rv[i][3] = ''; rv[i][4] = ''; rv[i][5] = ''; }
  if (rv.length > 1) rsh.getRange(1, 1, rv.length, rv[0].length).setValues(rv);
  var psh = sheet_(TABS.players);
  var pv = psh.getDataRange().getValues();
  for (var j = 1; j < pv.length; j++) pv[j][2] = Number(cfg.budget);
  if (pv.length > 1) psh.getRange(1, 1, pv.length, pv[0].length).setValues(pv);
  setConfig_('round', 0);
  setConfig_('roundOpen', 'false');
  setConfig_('deadline', '');
  log_('admin', 'RESET');
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/*  Sheet helpers                                                      */
/* ------------------------------------------------------------------ */

function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Tab ontbreekt: ' + name + ' (run setup())');
  return sh;
}

function readRows_(name) {
  var sh = sheet_(name);
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  var head = vals[0].map(String);
  var out = [];
  for (var i = 1; i < vals.length; i++) {
    if (vals[i].join('') === '') continue;
    var o = {};
    head.forEach(function (h, j) { o[h] = vals[i][j] === undefined || vals[i][j] === null ? '' : String(vals[i][j]); });
    out.push(o);
  }
  return out;
}

function readConfig_() {
  var o = {};
  readRows_(TABS.config).forEach(function (r) { o[r.key] = r.value; });
  return o;
}

function setConfig_(key, value) {
  var sh = sheet_(TABS.config);
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === key) { sh.getRange(i + 1, 2).setValue(value); return; }
  }
  sh.appendRow([key, value]);
}

function log_(who, what) {
  sheet_(TABS.log).appendRow([new Date().toISOString(), who, what]);
}

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

function normName_(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ø/gi, 'o').replace(/ł/gi, 'l').replace(/ß/g, 'ss').replace(/æ/gi, 'ae')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slug_(s) {
  return normName_(s).replace(/\s+/g, '-');
}

function makeToken_(n) {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var t = '';
  for (var i = 0; i < n; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  return t;
}

function uniq_(arr) {
  var s = {}, out = [];
  arr.forEach(function (x) { if (!s[x]) { s[x] = true; out.push(x); } });
  return out;
}

// Exports for the node test harness (ignored by Apps Script)
if (typeof module !== 'undefined') {
  module.exports = { validateBids_: validateBids_, resolveRound_: resolveRound_, parseStartlist_: parseStartlist_, parseResults_: parseResults_, normName_: normName_, slug_: slug_ };
}
