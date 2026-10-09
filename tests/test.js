// node tests/test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
const m = {};
new Function('module', 'require', src)(m, require);
const { validateBids_, resolveRound_, parseStartlist_, parseResults_, slug_ } = m.exports;

// --- resolveRound_: highest wins, tie = nobody
let r = resolveRound_([
  { rider_id: 'a', player: 'Jan', amount: 10 },
  { rider_id: 'a', player: 'Piet', amount: 12 },
  { rider_id: 'b', player: 'Jan', amount: 5 },
  { rider_id: 'b', player: 'Piet', amount: 5 },
  { rider_id: 'c', player: 'Kris', amount: 1 },
]);
assert.deepStrictEqual(r.winners.a, { player: 'Piet', amount: 12 });
assert.deepStrictEqual(r.winners.c, { player: 'Kris', amount: 1 });
assert.strictEqual(r.winners.b, undefined);
assert.deepStrictEqual(r.ties, ['b']);

// --- validateBids_
const riderById = { a: { id: 'a', name: 'A', owner: '' }, b: { id: 'b', name: 'B', owner: '' }, s: { id: 's', name: 'S', owner: 'Jan' } };
const ctx = (over) => Object.assign({ minBid: 1, maxRiders: 20, budgetLeft: 100, ownedCount: 0, existingBids: [], riderById }, over);

assert.ok(validateBids_([{ rider_id: 'a', amount: 60 }, { rider_id: 'b', amount: 40 }], ctx()).ok);
assert.ok(!validateBids_([{ rider_id: 'a', amount: 60 }, { rider_id: 'b', amount: 41 }], ctx()).ok, 'over budget');
assert.ok(!validateBids_([{ rider_id: 'a', amount: 0 }], ctx()).ok, 'below min');
assert.ok(!validateBids_([{ rider_id: 'a', amount: 2.5 }], ctx()).ok, 'not integer');
assert.ok(!validateBids_([{ rider_id: 's', amount: 5 }], ctx()).ok, 'already sold');
assert.ok(!validateBids_([{ rider_id: 'a', amount: 5 }, { rider_id: 'a', amount: 6 }], ctx()).ok, 'duplicate');
assert.ok(!validateBids_([{ rider_id: 'a', amount: 5 }], ctx({ existingBids: [{ rider_id: 'a', amount: 3 }] })).ok, 'cannot change bid');
assert.ok(!validateBids_([{ rider_id: 'b', amount: 50 }], ctx({ existingBids: [{ rider_id: 'a', amount: 60 }] })).ok, 'existing + new over budget');
assert.ok(!validateBids_([{ rider_id: 'b', amount: 1 }], ctx({ ownedCount: 19, existingBids: [{ rider_id: 'a', amount: 1 }] })).ok, 'roster cap');
assert.ok(validateBids_([{ rider_id: 'b', amount: 1 }], ctx({ ownedCount: 19 })).ok, 'roster cap exact');

// --- parseStartlist_ (PCS style paste)
const sl = `Soudal Quick-Step
1 EVENEPOEL Remco
2 LAMPAERT Yves 34
3 VAN WILDER Ilan DNS
UAE Team Emirates - XRG
11 POGAČAR Tadej
12 AYUSO Juan
`;
let p = parseStartlist_(sl);
assert.strictEqual(p.length, 5);
assert.deepStrictEqual(p[0], { name: 'EVENEPOEL Remco', team: 'Soudal Quick-Step' });
assert.deepStrictEqual(p[1], { name: 'LAMPAERT Yves', team: 'Soudal Quick-Step' });
assert.deepStrictEqual(p[3], { name: 'POGAČAR Tadej', team: 'UAE Team Emirates - XRG' });
// simple format
p = parseStartlist_('KOOIJ Olav;Visma | Lease a Bike\nPIDCOCK Tom\tQ36.5 Pro Cycling Team');
assert.strictEqual(p.length, 2);
assert.strictEqual(p[1].team, 'Q36.5 Pro Cycling Team');

// --- parseResults_
const riders = [
  { id: slug_('POGAČAR Tadej'), name: 'POGAČAR Tadej', team: 'UAE Team Emirates - XRG' },
  { id: slug_('EVENEPOEL Remco'), name: 'EVENEPOEL Remco', team: 'Soudal Quick-Step' },
  { id: slug_('KOOIJ Olav'), name: 'KOOIJ Olav', team: 'Visma | Lease a Bike' },
  { id: slug_('VAN WILDER Ilan'), name: 'VAN WILDER Ilan', team: 'Soudal Quick-Step' },
];
// PCS table paste: Rnk GC BIB Rider Age Team UCI Pnt Time
const res = `Rnk\tGC\tBIB\tRider\tAge\tTeam\tUCI\tPnt\tTime
1\t1\t11\tPOGACAR Tadej\t28\tUAE Team Emirates - XRG\t100\t40\t3:12:00
2\t2\t1\tEVENEPOEL Remco\t26\tSoudal Quick-Step\t70\t30\t,,
3\t5\t21\tKOOIJ Olav\t25\tVisma | Lease a Bike\t40\t20\t,,
40\t40\t3\tVAN WILDER Ilan\t26\tSoudal Quick-Step\t\t\t,,
41\t41\t99\tUNKNOWN Rider\t30\tSome Team\t3\t\t,,`;
let q = parseResults_(res, riders);
assert.deepStrictEqual(q.matched.map(x => [x.name, x.points]), [['POGAČAR Tadej', 100], ['EVENEPOEL Remco', 70], ['KOOIJ Olav', 40]]);
assert.strictEqual(q.unmatched.length, 1);
// simple format
q = parseResults_('Kooij Olav;25\nevenepoel remco\t12', riders);
assert.deepStrictEqual(q.matched.map(x => [x.name, x.points]), [['KOOIJ Olav', 25], ['EVENEPOEL Remco', 12]]);
// no team in paste: skip the age, take next number
q = parseResults_('1 POGACAR Tadej 28 100', riders);
assert.deepStrictEqual(q.matched.map(x => x.points), [100]);

console.log('all tests passed');
