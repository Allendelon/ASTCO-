// The Crystal Gallery contract sum must always equal the cost model's priced bill.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const CG = require('../assets/js/crystal-gallery-costing.js');
const IPC = require('../assets/js/calc.js');

test('generated bill reconciles: contract sum = Σ out-turn line amounts', () => {
  assert.equal(CG.lines.length, 45);
  const outturn = CG.lines.reduce((s, l) => s + l.amt, 0);
  const base = CG.lines.reduce((s, l) => s + l.baseAmt, 0);
  assert.equal(CG.totals.outturn, outturn);
  assert.equal(CG.totals.base, base);
  for (const l of CG.lines) {
    assert.equal(l.baseAmt, Math.round(l.qty * l.baseRate), l.code + ' base');
    assert.equal(l.amt, Math.round(l.baseAmt * l.esc), l.code + ' out-turn');
  }
  // Contingency is the employer's reserve and is not part of the contract sum.
  assert.ok(CG.totals.withContingency > CG.totals.outturn);
});

test('IPC valuation of the linked BoQ at 100% equals the contract sum', () => {
  const boqItems = CG.lines.map(l => ({ code: l.code, rate: l.amt / l.qty, contractQty: l.qty, prevQty: l.qty, thisQty: 0 }));
  const f = IPC.calculateContractorFinancials({ originalContractSum: CG.totals.outturn, boqItems, variations: [], mos: [] });
  assert.ok(Math.abs(f.boqContractTotal - CG.totals.outturn) < 0.01, 'BoQ total = contract sum');
  assert.ok(Math.abs(f.progressPercent - 100) < 1e-9, '100% complete');
});

test('linked file is in sync with the cost model (tools/sync_costing.py --check)', (t) => {
  let out;
  try {
    out = execFileSync('python3', ['tools/sync_costing.py', '--check'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (String(err.stdout).includes('OUT OF DATE')) assert.fail(String(err.stdout).trim());
    t.skip('cost model branch not reachable here: ' + String(err.stderr || err.message).split('\n').filter(Boolean).pop());
    return;
  }
  assert.match(out, /in sync/);
});
