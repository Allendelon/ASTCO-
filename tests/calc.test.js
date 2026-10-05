// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const IPC = require('../assets/js/calc.js');

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} !== ${b}`);

function contractor(overrides) {
  return Object.assign({
    originalContractSum: 1000000,
    advancePaymentOriginal: 100000,
    advanceRecoveryRate: 0.10,
    retentionRate: 0.10,
    retentionCapRate: 0.05,
    vatRate: 0.15,
    otherDeductionsToDate: 0,
    otherDeductionsPrev: 0,
    boqItems: [{ id: 1, rate: 1000, contractQty: 1000, prevQty: 100, thisQty: 50 }],
    variations: [],
    mos: []
  }, overrides);
}

test('basic BOQ valuation, retention, advance, VAT', () => {
  const f = IPC.calculateContractorFinancials(contractor());
  close(f.boqCumTotal, 150000, 'boq cum');
  close(f.boqPrevTotal, 100000, 'boq prev');
  close(f.retentionCum, 15000, 'retention cum');
  close(f.advRecoveredCum, 15000, 'advance cum');
  close(f.netPeriod, 50000 - 5000 - 5000, 'net period');
  close(f.vatPeriod, 40000 * 0.15, 'vat period');
  close(f.finalDuePeriod, 46000, 'final due period');
});

test('every period column equals cumulative minus previous (certificate reconciles)', () => {
  const f = IPC.calculateContractorFinancials(contractor({
    variations: [{ status: 'Approved', approvedSum: 200000, prevPct: 50, progressPct: 80 }],
    mos: [{ qty: 10, prevQty: 40, invoiceRate: 1000, certPct: 75 }], // MOS drawn down -> negative movement
    otherDeductionsToDate: 7000,
    otherDeductionsPrev: 2000
  }));
  const pairs = [
    ['grossCum', 'grossPrev', 'grossPeriod'],
    ['retentionCum', 'retentionPrev', 'retentionPeriod'],
    ['advRecoveredCum', 'advRecoveredPrev', 'advRecoveredPeriod'],
    ['totalDedCum', 'totalDedPrev', 'totalDedPeriod'],
    ['netCum', 'netPrev', 'netPeriod'],
    ['vatCum', 'vatPrev', 'vatPeriod'],
    ['finalDueCum', 'finalDuePrev', 'finalDuePeriod']
  ];
  pairs.forEach(([c, p, d]) => close(f[d], f[c] - f[p], d));
  close(f.grossPeriod - f.totalDedPeriod, f.netPeriod, 'A - B = C (period)');
  assert.ok(f.mosPeriodTotal < 0, 'MOS drawdown is negative, not clamped');
});

test('retention is capped at cap rate of revised contract sum', () => {
  const f = IPC.calculateContractorFinancials(contractor({
    boqItems: [{ rate: 1000, contractQty: 1000, prevQty: 400, thisQty: 300 }]
  }));
  close(f.retentionCap, 50000, 'cap');
  close(f.retentionCum, 50000, 'retention capped');
  close(f.retentionPrev, 40000, 'retention prev uncapped');
});

test('advance recovery never exceeds advance paid', () => {
  const f = IPC.calculateContractorFinancials(contractor({
    boqItems: [{ rate: 1000, contractQty: 1000, prevQty: 900, thisQty: 100 }]
  }));
  close(f.advRecoveredCum, 100000, 'advance capped');
  close(f.advRemainingBalance, 0, 'balance');
});

test('pending variations are excluded from revised sum and valuation', () => {
  const f = IPC.calculateContractorFinancials(contractor({
    variations: [{ status: 'Pending', approvedSum: 500000, prevPct: 0, progressPct: 100 }]
  }));
  close(f.revisedContractSum, 1000000, 'revised');
  close(f.voCumTotal, 0, 'vo cum');
});

test('zero rates are respected, not replaced by defaults', () => {
  const f = IPC.calculateContractorFinancials(contractor({ retentionRate: 0, advanceRecoveryRate: 0, vatRate: 0 }));
  close(f.retentionCum, 0, 'retention');
  close(f.advRecoveredCum, 0, 'advance');
  close(f.vatCum, 0, 'vat');
});

test('amount in words', () => {
  assert.equal(IPC.amountToWords(0), 'Zero Saudi Riyals and 00/100 Halalas Only.');
  assert.equal(IPC.amountToWords(1234567.89), 'One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven Saudi Riyals and 89/100 Halalas Only.');
  assert.equal(IPC.amountToWords(2000000000), 'Two Billion Saudi Riyals and 00/100 Halalas Only.');
  assert.equal(IPC.amountToWords(0.999), 'One Saudi Riyals and 00/100 Halalas Only.');
  assert.equal(IPC.amountToWords(-15.5), 'Minus Fifteen Saudi Riyals and 50/100 Halalas Only.');
});

test('IPC numbering and date helpers', () => {
  assert.equal(IPC.formatIpcNo(9), 'IPC-09');
  assert.equal(IPC.formatIpcNo(10), 'IPC-10');
  assert.equal(IPC.parseIpcNo('IPC-12'), 12);
  assert.equal(IPC.addMonths('25 Sep 2026', 1), '25 Oct 2026');
  assert.equal(IPC.addMonths('31 Jan 2026', 1), '28 Feb 2026');
  assert.equal(IPC.addMonths('15 Dec 2026', 1), '15 Jan 2027');
  assert.equal(IPC.addMonths('01 Jan 2026', -1), '01 Dec 2025');
  assert.equal(IPC.monthsBetween('15 Jan 2025', '15 Jul 2027'), 30);
  assert.equal(IPC.formatDeduction(100), '(SAR 100.00)');
  assert.equal(IPC.formatDeduction(-100), 'SAR 100.00');
});
