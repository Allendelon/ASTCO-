// Run: npm test   (Node 18+, built-in test runner, no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const DATA = require('../assets/data.js');
const E = require('../assets/engine.js');
const A = require('../assets/adapters.js');
const CG = require('../assets/feeds/crystal-gallery-costing.js');

const linked = DATA.linkedProjects.map(l => A.projectFromCosting(CG, JSON.parse(JSON.stringify(l.meta))));
const all = [...DATA.projects, ...linked];

test('every project reconciles: budgets + contingency = BAC, baseline = BAC, actuals = certified', () => {
  for (const p of all) assert.deepEqual(E.integrityChecks(p, E.projectMetrics(p)), [], p.name);
});

test('EVM indices are computed from data, not constants', () => {
  const cpis = DATA.projects.map(p => E.projectMetrics(p).cpi.toFixed(3));
  assert.ok(new Set(cpis).size > 1, 'CPI should differ between projects');
  const m = E.projectMetrics(DATA.projects[0]);
  assert.ok(Math.abs(m.cpi - m.ev / m.ac) < 1e-12);
  assert.ok(Math.abs(m.spi - m.ev / m.pv) < 1e-12);
});

test('headroom equals free contingency', () => {
  for (const p of DATA.projects) {
    const m = E.projectMetrics(p);
    assert.ok(Math.abs(m.headroom - (m.contRemaining - E.sum(m.pkgs, k => k.variance))) < 1e-9, p.name);
  }
});

test('EAC never sits below committed value', () => {
  const p = JSON.parse(JSON.stringify(DATA.projects[0]));
  p.commitments.push({ id: 'C-900', title: 'x', vendor: 'y', pkg: 'PMO', original: 5, variations: 0, certified: 0, status: 'Active' });
  const k = E.projectMetrics(p).pkgs.find(x => x.code === 'PMO');
  assert.equal(k.eac, k.committed);
  assert.ok(k.eacRaised);
});

test('Monte Carlo is reproducible and ordered', () => {
  const p = DATA.projects[3], m = E.projectMetrics(p);
  const a = E.monteCarlo(p, m), b = E.monteCarlo(p, m);
  assert.equal(a.p80, b.p80);
  assert.ok(a.p10 <= a.p50 && a.p50 <= a.p80 && a.p80 <= a.p90);
  assert.ok(a.probWithinBac >= 0 && a.probWithinBac <= 1);
});

test('stress scenario raises cost', () => {
  const p = DATA.projects[0], m = E.projectMetrics(p);
  const base = E.monteCarlo(p, m), hot = E.monteCarlo(p, m, { delayMonths: 6, escalationPct: 10, aprPct: 9 });
  assert.ok(hot.p50 > base.p50);
  assert.ok(E.scenarioCost(p, m, { delayMonths: 3, escalationPct: 0, aprPct: 6.5 }).financing > 0);
});

test('cash-flow forecast lands on EAC', () => {
  for (const p of all) {
    const m = E.projectMetrics(p), cf = E.cashflow(p, m);
    assert.ok(Math.abs(cf.cumForecast[cf.cumForecast.length - 1] - m.eac) < 1e-6, p.name);
  }
});

test('triangular sampler respects bounds', () => {
  const r = E.mulberry32(1);
  for (let i = 0; i < 2000; i++) { const v = E.triangular(r(), 2, 3, 7); assert.ok(v >= 2 && v <= 7); }
});

test('Crystal Gallery feed matches the cost model totals the IPC System uses', () => {
  const p = linked[0];
  assert.ok(Math.abs(E.sum(p.packages, k => k.budget) - CG.totals.outturn / 1e6) < 1e-6);
  assert.ok(Math.abs(p.bac - CG.totals.withContingency / 1e6) < 1e-6);
  assert.equal(p.start, '2027-03');
});

test('planner cash-flow CSV parses and rescales to BAC', () => {
  const csv = [
    'month,start_day,end_day,baseline_BL0,forecast,cum_baseline_BL0,cum_forecast,contingency_5pct_prorata,forecast_incl_contingency,currency',
    'Mar 27,0,31,"10,000,000",9000000,10000000,9000000,450000,9450000,SAR',
    'Apr 27,31,61,30000000,31000000,40000000,40000000,1550000,32550000,SAR',
    'Sept 27,61,91,60000000,60000000,100000000,100000000,3000000,63000000,SAR'
  ].join('\n');
  const parsed = A.parsePlannerCashflow(csv);
  assert.equal(parsed.start, '2027-03');
  assert.deepEqual(parsed.baseline, [10, 30, 60]);
  assert.equal(parsed.currency, 'SAR');
  const { project } = A.applyPlannerCashflow(linked[0], parsed);
  assert.ok(Math.abs(E.sum(project.monthlyBaseline) - linked[0].bac) < 1e-9);
  assert.throws(() => A.parsePlannerCashflow('a,b\n1,2'), /Not a 4D Planner/);
});

test('midad-feed/1 validation', () => {
  assert.throws(() => A.parseFeed('{}'), /midad-feed\/1/);
  assert.throws(() => A.parseFeed('not json'), /valid JSON/);
  const p = A.parseFeed(JSON.stringify({ schema: 'midad-feed/1', project: DATA.projects[1] }));
  assert.equal(p.id, 'p2');
});

test('exceptions surface pending approvals', () => {
  const p = DATA.projects[0], m = E.projectMetrics(p);
  const ex = E.exceptions(p, m, E.monteCarlo(p, m));
  assert.ok(ex.some(e => e.kind === 'Approval' && e.title.includes('C-103')));
});
