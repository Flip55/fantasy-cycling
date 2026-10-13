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
  imports: 'Imports',
  log:     'Log'
};

var HEADERS = {
  Config:  ['key', 'value'],
  Players: ['name', 'token', 'budget_left'],
  Riders:  ['id', 'name', 'team', 'owner', 'price', 'round'],
  Bids:    ['round', 'player', 'rider_id', 'amount', 'timestamp'],
  Results: ['label', 'rider_id', 'points', 'timestamp', 'pcs'],  // points = UCI column, pcs = PCS 'Pnt' column
  Imports: ['label', 'first_at', 'last_at', 'by', 'rows', 'source'],
  Log:     ['timestamp', 'who', 'what']
};

var DEFAULT_CONFIG = {
  raceName:   'Tour of Guangxi 2026',
  raceSlug:   'tour-of-guangxi/2026', // part of the PCS URL; imports from other pages are refused
  stages:     6,
  lockHour:   22,      // Brussels time: a label is frozen at this hour on the day of its first import
  scoring:    'uci',   // 'uci' = UCI points column, 'pcs' = PCS points column ('Pnt'). Both are stored; this picks which counts.
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
      case 'submitResults':   return submitResults_(p);
      // admin
      case 'addPlayer':       return admin_(p, addPlayer_);
      case 'openRound':       return admin_(p, openRound_);
      case 'closeRound':      return admin_(p, closeRound_);
      case 'setDeadline':     return admin_(p, setDeadline_);
      case 'setScoring':      return admin_(p, setScoring_);
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
    var v = cfg.scoring === 'pcs' ? Number(r.pcs || 0) : Number(r.points || 0);
    pointsByRider[r.rider_id] = (pointsByRider[r.rider_id] || 0) + v;
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
      deadline: cfg.deadline,
      stages: Number(cfg.stages || 6),
      scoring: cfg.scoring === 'pcs' ? 'pcs' : 'uci',
      lockHour: Number(cfg.lockHour || 22),
      raceSlug: cfg.raceSlug || ''
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
    resultLabels: uniq_(results.map(function (r) { return r.label; })),
    imports: readRows_(TABS.imports).map(function (i) {
      return { label: i.label, name: labelName_(i.label), firstAt: i.first_at, lastAt: i.last_at, by: i.by, rows: Number(i.rows), source: i.source,
               locked: isLocked_(i.first_at, new Date(), Number(cfg.lockHour || 22)) };
    })
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

function setScoring_(p) {
  var v = String(p.scoring || '').toLowerCase();
  if (v !== 'uci' && v !== 'pcs') return { ok: false, error: 'scoring moet uci of pcs zijn' };
  setConfig_('scoring', v);
  log_('admin', 'scoring = ' + v);
  return { ok: true, scoring: v };
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

// PCS startlist parser – shared source for index.html and Code.gs (kept here for tests).
// Handles the "one long line" PCS copy:  "1 Team Jayco AlUla 1. DOUBLE Paul 2. DE BONDT Dries ... DS: DE MARCHI Alessandro 2 Alpecin - Premier Tech 11. BAYER Tobias ..."
// and the multi-line variants ("1. DOUBLE Paul" or "1 DOUBLE Paul" per line, team names on their own lines).
function parsePcsStartlist_(text) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  var out = [];
  // rider token: "<bib>. NAME Firstname" up to next "<bib>." / "DS:" / end
  var re = /(\d{1,3})\.\s*([^\d]+?)(?=\s*(?:\d{1,3}\.\s*[^\d]|DS:|$))/g;
  var m, prevEnd = 0, team = '', n = 0;
  while ((m = re.exec(t)) !== null) {
    var gap = t.slice(prevEnd, m.index).trim();
    if (gap) {
      // gap looks like "DS: X Y 2 Alpecin - Premier Tech" or (first) "1 Team Jayco AlUla"
      var g = gap.replace(/^[\s\S]*?DS:\s*/, '');
      var tm = g.match(/^(?:.*?\s)?(\d{1,2})\s+(.+)$/);
      if (tm) team = tm[2].trim();
      else if (!/DS:/.test(gap)) team = g.trim();
    }
    var name = m[2].replace(/\s+(DNS|DNF|OTL|DSQ)$/i, '').trim();
    if (/[A-ZÀ-Ž]{2,}/.test(name) && name.length > 3) { out.push({ name: name, team: team }); n++; }
    prevEnd = m.index + m[0].length;
  }
  return out;
}

/**
 * Pure. Accepts:
 *   - PCS startlist copy/paste: team name lines followed by "123 SURNAME Firstname" lines
 *   - simple lines "SURNAME Firstname;Team" or "SURNAME Firstname\tTeam"
 */
function parseStartlist_(text) {
  if (/DS:/.test(text) || String(text).trim().split('\n').length < 3) {
    var quick = parsePcsStartlist_(text);
    if (quick.length >= 5) return quick;
  }
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
 * Admin import (paste). Bypasses the lock and the race check. p = { label, text }
 */
function importResults_(p) {
  var riders = readRows_(TABS.riders);
  var label = normalizeLabel_(p.label);
  if (!label) return { ok: false, error: 'Onbekend label. Gebruik stage-1 … stage-N, gc, points, kom of youth.' };
  var parsed = parseResults_(String(p.text || ''), riders);
  return storeImport_(label, parsed.matched, parsed.unmatched, 'admin', 'paste', true);
}

/**
 * Player import. p = { token, url, rows:[{name,team,uci,href}] }  (bookmarklet)
 *             or  { token, label, text }                            (paste fallback)
 * Rules: valid player; page must belong to this race; only final classifications
 * (no intermediate GC tabs); label frozen after lockHour on the day of its first import.
 */
function submitResults_(p) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var cfg = readConfig_();
    var players = readRows_(TABS.players);
    var me = players.filter(function (x) { return x.token === p.token; })[0];
    if (!me) return { ok: false, error: 'Onbekende speler/code. Log eerst in op de site.' };
    var riders = readRows_(TABS.riders);
    var label, matched, unmatched, source;
    if (p.rows) {
      var url = String(p.url || '');
      if (!isRacePage_(url, cfg.raceSlug)) {
        return { ok: false, error: 'Dit is geen pagina van ' + cfg.raceName + ' (verwacht "' + cfg.raceSlug + '" in de URL).' };
      }
      var d = deriveLabel_(url);
      if (d.error) return { ok: false, error: d.error };
      label = d.label; source = url;
      var m = matchRows_(p.rows, riders);
      matched = m.matched; unmatched = m.unmatched;
    } else {
      label = normalizeLabel_(p.label);
      if (!label) return { ok: false, error: 'Kies een geldig label.' };
      source = 'paste';
      var parsed = parseResults_(String(p.text || ''), riders);
      matched = parsed.matched; unmatched = parsed.unmatched;
    }
    var existing = readRows_(TABS.imports).filter(function (i) { return i.label === label; })[0];
    if (existing && isLocked_(existing.first_at, new Date(), Number(cfg.lockHour || 22))) {
      return { ok: false, error: labelName_(label) + ' is vastgezet (eerste import ' + fmtBrussels_(existing.first_at) + ', slot om ' + cfg.lockHour + 'u). Wijzigingen zijn niet meer mogelijk.' };
    }
    return storeImport_(label, matched, unmatched, me.name, source, false);
  } finally {
    lock.releaseLock();
  }
}

/** Writes results + the Imports log row. Returns the API response. */
function storeImport_(label, matched, unmatched, by, source, isAdmin) {
  if (!matched || matched.length === 0) return { ok: false, error: 'Geen renners met punten herkend op deze pagina.' };
  var cfg = readConfig_();
  deleteLabel_(label);
  var sh = sheet_(TABS.results);
  var nowIso = new Date().toISOString();
  if (sh.getLastColumn() < 5) sh.getRange(1, 5).setValue('pcs');
  var rows = matched.map(function (m) { return [label, m.rider_id, m.points, nowIso, m.pcs || 0]; });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
  // upsert Imports
  var ish = sheet_(TABS.imports);
  var vals = ish.getDataRange().getValues();
  var found = false, firstAt = nowIso;
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === label) {
      firstAt = String(vals[i][1]) || nowIso;
      ish.getRange(i + 1, 1, 1, 6).setValues([[label, firstAt, nowIso, by, matched.length, source]]);
      found = true; break;
    }
  }
  if (!found) ish.appendRow([label, nowIso, nowIso, by, matched.length, source]);
  log_(by, 'resultaten ' + label + ': ' + matched.length + ' renners' + (isAdmin ? ' (admin)' : ''));
  return { ok: true, label: label, name: labelName_(label), matched: matched.length, unmatched: (unmatched || []).slice(0, 30),
           locked: isLocked_(firstAt, new Date(), Number(cfg.lockHour || 22)), firstAt: firstAt };
}

/**
 * Pure. PCS URL -> label.  .../race/tour-of-guangxi/2026/stage-3 -> stage-3
 * Final classifications: /gc /points /kom /youth. Intermediate tabs (stage-3-gc) are refused.
 */
function deriveLabel_(url) {
  var path = String(url || '').replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\/results?$/, '');
  var seg = path.split('/').pop() || '';
  // PCS uses both ".../tour-of-guangxi/2026/stage-1" and the flat ".../tour-of-guangxi-2026-stage-1".
  var m;
  if ((m = seg.match(/(?:^|-)stage-(\d+)-(gc|points|kom|youth|teams)$/))) {
    return { error: 'Dit is een tussenstand (stage-' + m[1] + '-' + m[2] + '). Enkel de etappe-uitslag (stage-N) en de eindklassementen (gc, points, kom, youth) tellen.' };
  }
  if ((m = seg.match(/(?:^|-)stage-(\d+)$/))) return { label: 'stage-' + Number(m[1]) };
  if ((m = seg.match(/(?:^|-\d{4}-)(gc|points|kom|youth)$/))) return { label: m[1] };
  if (/(?:^|-)(teams|stages|startlist|result|results)$/.test(seg) || !seg || /^\d{4}$/.test(seg)) {
    return { error: 'Open de uitslag van een etappe (URL eindigt op stage-N) of een eindklassement (gc, points, kom, youth).' };
  }
  return { error: 'Onbekende pagina "' + seg + '". Verwacht stage-N, gc, points, kom of youth.' };
}

/** Pure. Slug "tour-of-guangxi/2026" matches both ".../tour-of-guangxi/2026/..." and ".../tour-of-guangxi-2026-...". */
function isRacePage_(url, raceSlug) {
  if (!raceSlug) return true;
  var norm = function (x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); };
  return norm(url).indexOf(norm(raceSlug)) >= 0;
}

/** Pure. Accepts "stage-3", "Etappe 3", "3", "gc", "Eindklassement", ... */
function normalizeLabel_(input) {
  var s = String(input || '').trim().toLowerCase();
  var m;
  if ((m = s.match(/^(?:stage|etappe|rit)?[\s-]*(\d+)$/))) return 'stage-' + Number(m[1]);
  if (/^(gc|eindklassement|algemeen)$/.test(s)) return 'gc';
  if (/^(points|punten|puntenklassement|groen)$/.test(s)) return 'points';
  if (/^(kom|berg|bergklassement|bolletjes)$/.test(s)) return 'kom';
  if (/^(youth|jongeren|jongerenklassement|wit)$/.test(s)) return 'youth';
  return null;
}

function labelName_(label) {
  var m;
  if ((m = String(label).match(/^stage-(\d+)$/))) return 'Etappe ' + m[1];
  return { gc: 'Eindklassement', points: 'Puntenklassement', kom: 'Bergklassement', youth: 'Jongerenklassement' }[label] || label;
}

/** Pure. Rows from the bookmarklet -> matched riders (exact name, then token-set, then PCS href). */
function matchRows_(rows, riders) {
  var byKey = {}, byTokens = {};
  riders.forEach(function (r) {
    var k = normName_(r.name);
    byKey[k] = r;
    byTokens[k.split(' ').sort().join(' ')] = r;
  });
  var matched = [], unmatched = [], seen = {};
  (rows || []).forEach(function (row) {
    var pts = Number(row.uci) || 0, pcs = Number(row.pcs) || 0;
    if (pts <= 0 && pcs <= 0) return;
    var k = normName_(row.name);
    var r = byKey[k] || byTokens[k.split(' ').sort().join(' ')];
    if (!r && row.href) {
      var slug = String(row.href).split('/').pop();
      r = byTokens[normName_(slug.replace(/-/g, ' ')).split(' ').sort().join(' ')];
    }
    if (!r) { unmatched.push(row.name + ' (' + (pts || pcs) + ')'); return; }
    if (seen[r.id]) return;
    seen[r.id] = true;
    matched.push({ rider_id: r.id, name: r.name, points: Math.round(pts), pcs: Math.round(pcs) });
  });
  return { matched: matched, unmatched: unmatched };
}

/** Brussels date + hour of a Date. Uses Utilities in Apps Script, Intl in node. */
function brussels_(d) {
  if (typeof Utilities !== 'undefined') {
    return { date: Utilities.formatDate(d, 'Europe/Brussels', 'yyyy-MM-dd'), hour: Number(Utilities.formatDate(d, 'Europe/Brussels', 'H')) };
  }
  var parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(d);
  var g = {}; parts.forEach(function (x) { g[x.type] = x.value; });
  return { date: g.year + '-' + g.month + '-' + g.day, hour: Number(g.hour) % 24 };
}

/** Pure. Locked once Brussels time reaches lockHour on the day of the first import (or any later day). */
function isLocked_(firstAtIso, now, lockHour) {
  if (!firstAtIso) return false;
  var f = brussels_(new Date(firstAtIso)), n = brussels_(now);
  return n.date > f.date || (n.date === f.date && n.hour >= lockHour);
}

function fmtBrussels_(iso) {
  if (!iso) return '';
  if (typeof Utilities !== 'undefined') return Utilities.formatDate(new Date(iso), 'Europe/Brussels', 'dd/MM HH:mm');
  return new Date(iso).toLocaleString('nl-BE', { timeZone: 'Europe/Brussels' });
}

function deleteResults_(p) {
  var label = normalizeLabel_(p.label) || String(p.label || '').trim();
  var n = deleteLabel_(label);
  var ish = sheet_(TABS.imports);
  var iv = ish.getDataRange().getValues();
  for (var i = iv.length - 1; i >= 1; i--) if (String(iv[i][0]) === label) ish.deleteRow(i + 1);
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
    var points = null, pcs = 0;
    var simple = rest.match(/^\s*[;,\t]\s*(\d+)(?:\s*[;,\t]\s*(\d+))?\s*$/);
    var cells = raw.indexOf('\t') >= 0 ? raw.split('\t').map(function (c) { return c.trim(); }) : null;
    var ti = -1;
    if (cells && hit.teamKey) for (var ci = 0; ci < cells.length; ci++) if (normName_(cells[ci]) === hit.teamKey) { ti = ci; break; }
    if (simple) {
      points = Number(simple[1]); pcs = Number(simple[2] || 0);
    } else if (ti >= 0) {
      // PCS table paste: columns after Team are UCI, Pnt (either may be blank)
      points = parseInt(cells[ti + 1], 10) || 0; pcs = parseInt(cells[ti + 2], 10) || 0;
    } else {
      var afterTeam = hit.teamKey && rest.indexOf(hit.teamKey) >= 0 ? rest.slice(rest.indexOf(hit.teamKey) + hit.teamKey.length) : null;
      var src = afterTeam !== null ? afterTeam : rest.replace(/^\s*\d{2}\s/, ' '); // drop age if no team found
      var nums = src.match(/\d+/g) || [];
      if (nums.length) { points = Number(nums[0]); pcs = Number(nums[1] || 0); }
    }
    if ((points === null || points <= 0) && pcs <= 0) return;
    if (seen[hit.id]) return;
    seen[hit.id] = true;
    matched.push({ rider_id: hit.id, name: hit.name, points: points || 0, pcs: pcs });
  });
  return { matched: matched, unmatched: unmatched };
}

/* ------------------------------------------------------------------ */
/*  Admin: reset (keeps players & riders, clears auction and results)  */
/* ------------------------------------------------------------------ */

function reset_(p, cfg) {
  if (p.confirm !== 'RESET') return { ok: false, error: 'bevestig met confirm: "RESET"' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  [TABS.bids, TABS.results, TABS.imports].forEach(function (n) {
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
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh && HEADERS[name]) { sh = ss.insertSheet(name); sh.appendRow(HEADERS[name]); sh.setFrozenRows(1); }
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
  module.exports = { validateBids_: validateBids_, resolveRound_: resolveRound_, parseStartlist_: parseStartlist_, parseResults_: parseResults_, normName_: normName_, slug_: slug_, deriveLabel_: deriveLabel_, isRacePage_: isRacePage_, normalizeLabel_: normalizeLabel_, matchRows_: matchRows_, isLocked_: isLocked_, labelName_: labelName_ };
}
