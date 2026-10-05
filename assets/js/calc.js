/*
 * ASCTO IPC — pure calculation & formatting functions.
 * No DOM access here so the maths can be unit-tested under Node (see tests/).
 *
 * Invariant enforced throughout: every "period" figure is exactly (cumulative - previous),
 * so the three certificate columns always reconcile (A - B = C in every column).
 */
(function (root) {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  /* ---------- Formatting ---------- */

  function formatSAR(n) {
    const v = Number.isFinite(n) ? n : 0;
    return 'SAR ' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Accounting style: deductions shown in brackets; a negative deduction (a release) shown plain.
  function formatDeduction(n) {
    const v = Number.isFinite(n) ? n : 0;
    if (Math.abs(v) < 0.005) return formatSAR(0);
    return v > 0 ? '(' + formatSAR(v) + ')' : formatSAR(-v);
  }

  function formatNumber(n, dec) {
    const d = dec === undefined ? 2 : dec;
    const v = Number.isFinite(n) ? n : 0;
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function formatIpcNo(n) {
    return 'IPC-' + String(n).padStart(2, '0');
  }

  function parseIpcNo(s) {
    const m = /(\d+)\s*$/.exec(String(s || ''));
    return m ? parseInt(m[1], 10) : 1;
  }

  /* ---------- Dates ("01 Sep 2026") — parsed manually; Date.parse of this format is not standardised ---------- */

  function parseDMY(s) {
    const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(String(s || '').trim());
    if (!m) return null;
    const mi = MONTHS.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase());
    if (mi < 0) return null;
    return { d: parseInt(m[1], 10), m: mi, y: parseInt(m[3], 10) };
  }

  function formatDMY(o) {
    return String(o.d).padStart(2, '0') + ' ' + MONTHS[o.m] + ' ' + o.y;
  }

  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  }

  function addMonths(s, k) {
    const p = parseDMY(s);
    if (!p) return s;
    const total = p.y * 12 + p.m + k;
    const y = Math.floor(total / 12);
    const m = total % 12;
    return formatDMY({ d: Math.min(p.d, daysInMonth(y, m)), m: m, y: y });
  }

  function monthsBetween(a, b) {
    const pa = parseDMY(a);
    const pb = parseDMY(b);
    if (!pa || !pb) return 0;
    return (pb.y - pa.y) * 12 + (pb.m - pa.m);
  }

  function shortMonth(s) {
    const p = parseDMY(s);
    return p ? MONTHS[p.m] + ' ' + p.y : String(s || '');
  }

  /* ---------- Amount in words ---------- */

  const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];

  function hundredsToWords(n) {
    const parts = [];
    if (n >= 100) {
      parts.push(ONES[Math.floor(n / 100)] + ' Hundred');
      n %= 100;
    }
    if (n > 0) {
      parts.push(n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''));
    }
    return parts.join(' ');
  }

  function integerToWords(n) {
    if (n === 0) return 'Zero';
    const parts = [];
    let scale = 0;
    while (n > 0 && scale < SCALES.length) {
      const chunk = n % 1000;
      if (chunk) parts.unshift(hundredsToWords(chunk) + (SCALES[scale] ? ' ' + SCALES[scale] : ''));
      n = Math.floor(n / 1000);
      scale++;
    }
    return parts.join(' ');
  }

  function amountToWords(amount) {
    const v = Number.isFinite(amount) ? amount : 0;
    // Work in integer halalas so 0.995 can never render as "100/100".
    const totalHalalas = Math.round(Math.abs(v) * 100);
    const riyals = Math.floor(totalHalalas / 100);
    const halalas = totalHalalas % 100;
    const prefix = v < 0 && totalHalalas > 0 ? 'Minus ' : '';
    return prefix + integerToWords(riyals) + ' Saudi Riyals and ' + String(halalas).padStart(2, '0') + '/100 Halalas Only.';
  }

  /* ---------- Core IPC valuation ---------- */

  function calculateContractorFinancials(c) {
    if (!c) return null;

    let boqContractTotal = 0, boqCumTotal = 0, boqPrevTotal = 0;
    (c.boqItems || []).forEach(function (i) {
      const rate = num(i.rate);
      boqContractTotal += num(i.contractQty) * rate;
      boqPrevTotal += num(i.prevQty) * rate;
      boqCumTotal += (num(i.prevQty) + num(i.thisQty)) * rate;
    });

    let voApprovedTotal = 0, voCumTotal = 0, voPrevTotal = 0;
    (c.variations || []).forEach(function (vo) {
      if (vo.status !== 'Approved') return;
      const sum = num(vo.approvedSum);
      voApprovedTotal += sum;
      voCumTotal += sum * num(vo.progressPct) / 100;
      voPrevTotal += sum * num(vo.prevPct) / 100;
    });

    // MOS is a stock valuation: when materials are built in, the MOS balance falls and the
    // period movement is negative. That is correct and must not be clamped to zero.
    let mosInvoiceTotal = 0, mosCumTotal = 0, mosPrevTotal = 0;
    (c.mos || []).forEach(function (m) {
      const rate = num(m.invoiceRate);
      const pct = num(m.certPct) / 100;
      mosInvoiceTotal += num(m.qty) * rate;
      mosCumTotal += num(m.qty) * rate * pct;
      mosPrevTotal += num(m.prevQty) * rate * pct;
    });

    const grossCum = boqCumTotal + voCumTotal + mosCumTotal;
    const grossPrev = boqPrevTotal + voPrevTotal + mosPrevTotal;

    const revisedContractSum = num(c.originalContractSum) + voApprovedTotal;
    const progressPercent = revisedContractSum > 0 ? (grossCum / revisedContractSum) * 100 : 0;

    const retRate = c.retentionRate != null ? num(c.retentionRate) : 0.10;
    const retCapRate = c.retentionCapRate != null ? num(c.retentionCapRate) : 0.05;
    const retentionCap = revisedContractSum * retCapRate;
    const retentionCum = Math.min((boqCumTotal + voCumTotal) * retRate, retentionCap);
    const retentionPrev = Math.min((boqPrevTotal + voPrevTotal) * retRate, retentionCap);

    const advTotalPaid = num(c.advancePaymentOriginal);
    const advRate = c.advanceRecoveryRate != null ? num(c.advanceRecoveryRate) : 0.10;
    const advRecoveredCum = Math.min(grossCum * advRate, advTotalPaid);
    const advRecoveredPrev = Math.min(grossPrev * advRate, advTotalPaid);

    const otherDeductionsCum = num(c.otherDeductionsToDate);
    const otherDeductionsPrev = num(c.otherDeductionsPrev);

    const totalDedCum = retentionCum + advRecoveredCum + otherDeductionsCum;
    const totalDedPrev = retentionPrev + advRecoveredPrev + otherDeductionsPrev;

    const netCum = grossCum - totalDedCum;
    const netPrev = grossPrev - totalDedPrev;

    const vatRate = c.vatRate != null ? num(c.vatRate) : 0.15;
    const vatCum = netCum * vatRate;
    const vatPrev = netPrev * vatRate;

    const r = {
      boqContractTotal, boqCumTotal, boqPrevTotal, boqPeriodTotal: boqCumTotal - boqPrevTotal,
      voApprovedTotal, voCumTotal, voPrevTotal, voPeriodTotal: voCumTotal - voPrevTotal,
      mosInvoiceTotal, mosCumTotal, mosPrevTotal, mosPeriodTotal: mosCumTotal - mosPrevTotal,
      grossCum, grossPrev, grossPeriod: grossCum - grossPrev,
      revisedContractSum, progressPercent,
      retentionRate: retRate, retentionCapRate: retCapRate, retentionCap,
      retentionCum, retentionPrev, retentionPeriod: retentionCum - retentionPrev,
      advTotalPaid, advRecoveryRate: advRate,
      advRecoveredCum, advRecoveredPrev, advRecoveredPeriod: advRecoveredCum - advRecoveredPrev,
      advRemainingBalance: Math.max(0, advTotalPaid - advRecoveredCum),
      otherDeductionsCum, otherDeductionsPrev, otherDeductionsPeriod: otherDeductionsCum - otherDeductionsPrev,
      totalDedCum, totalDedPrev, totalDedPeriod: totalDedCum - totalDedPrev,
      netCum, netPrev, netPeriod: netCum - netPrev,
      vatRate, vatCum, vatPrev, vatPeriod: vatCum - vatPrev,
      finalDueCum: netCum + vatCum, finalDuePrev: netPrev + vatPrev
    };
    r.finalDuePeriod = r.finalDueCum - r.finalDuePrev;
    return r;
  }

  /* ---------- Planned baseline (indicative logistic S-curve) ---------- */

  function logisticShare(x) {
    const f = function (t) { return 1 / (1 + Math.exp(-10 * (t - 0.5))); };
    return (f(x) - f(0)) / (f(1) - f(0));
  }

  const api = {
    MONTHS, num, round2,
    formatSAR, formatDeduction, formatNumber, formatIpcNo, parseIpcNo,
    parseDMY, formatDMY, addMonths, monthsBetween, shortMonth,
    amountToWords, calculateContractorFinancials, logisticShare
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IPC = api;
})(typeof window !== 'undefined' ? window : globalThis);
