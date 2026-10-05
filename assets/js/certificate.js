/*
 * ASCTO IPC — certificate model.
 * Maps a contractor's valuation onto the official "CONTRACTOR PAYMENT CERTIFICATE" template
 * (assets/templates/ipc-template.xlsx, sheet IPC-000-000, print area A1:M62).
 * The same model feeds the on-screen certificate and the Excel export, so they cannot drift apart.
 * Pure: no DOM access (unit-tested under Node).
 */
(function (root) {
  'use strict';

  const IPC = root.IPC || (typeof require !== 'undefined' ? require('./calc.js') : null);
  const { num, amountToWords, monthsBetween, parseIpcNo, parseDMY, MONTHS } = IPC;

  const CONSULTANT_POSITIONS = ['Sr. Engineer', 'Quantity Surveyor', 'Contracts Administrator', 'Project Manager'];

  function defaultSettings() {
    return {
      employerName: 'ASCTO',
      siteOffice: {
        department: 'Project Control',
        signatories: [
          { name: 'Arif Jamal Ansari', position: 'Planning & Control Manager' },
          { name: 'Hatem Abu Elela', position: 'Chief Development Officer' }
        ]
      },
      homeOffice: {
        department: '',
        signatories: [
          { name: '', position: 'Finance Director' },
          { name: '', position: 'CEO / President' }
        ]
      }
    };
  }

  function pct(n, dec) {
    return (Number.isFinite(n) ? n : 0).toFixed(dec === undefined ? 2 : dec) + '%';
  }

  function templateIpcNo(s) {
    return 'IPC ' + String(parseIpcNo(s)).padStart(2, '0');
  }

  function monthYear(dmy) {
    const p = parseDMY(dmy);
    return p ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][p.m] + '-' + p.y : String(dmy || '');
  }

  function line(row, no, desc, last, cur, cum, style, remark) {
    return { row: row, no: no, desc: desc, last: last, this: cur, cum: cum, style: style || '', remark: remark || '' };
  }

  function buildCertificate(settings, project, c, fin) {
    const s = settings || defaultSettings();
    const parts = String(c.valuationPeriod || '').split(' to ');
    const periodEnd = parts[1] || parts[0] || '';
    const months = monthsBetween(project.commenceDate, project.completeDate);

    const mosPct = fin.mosInvoiceTotal > 0 ? (fin.mosCumTotal / fin.mosInvoiceTotal) * 100 : 0;
    const advPct = num(c.originalContractSum) > 0 ? (fin.advTotalPaid / num(c.originalContractSum)) * 100 : 0;
    const relPct = fin.retentionCum > 0 ? (fin.retRelease.cum / fin.retentionCum) * 100 : 0;
    const worksPrev = fin.boqPrevTotal + fin.mosPrevTotal;
    const worksCum = fin.boqCumTotal + fin.mosCumTotal;

    const lines = [
      line(23, '01', 'Valuation of Work Done', worksPrev, worksCum - worksPrev, worksCum, 'head'),
      line(24, '01.1', pct(mosPct) + ' Approved Material on Site (MIR)', fin.mosPrevTotal, fin.mosPeriodTotal, fin.mosCumTotal, 'sub'),
      line(25, '01.2', '100.00% Approved Installation (WIR)', fin.boqPrevTotal, fin.boqPeriodTotal, fin.boqCumTotal, 'sub'),
      line(26, '02', 'Reimbursable Expenses, Equipment, Transportation etc.', fin.reimb.prev, fin.reimb.period, fin.reimb.cum),
      line(27, '03', 'Variations/ Extra Works', fin.voPrevTotal, fin.voPeriodTotal, fin.voCumTotal),
      line(28, '04', pct(advPct, 0) + ' Advance Payment', fin.advPaid.prev, fin.advPaid.period, fin.advPaid.cum),
      line(29, '05', pct(relPct) + ' Release of Retention', fin.retRelease.prev, fin.retRelease.period, fin.retRelease.cum),
      line(30, '06', 'VAT Adjustment Value', fin.vatAdj.prev, fin.vatAdj.period, fin.vatAdj.cum, 'vatadj'),
      line(31, 'A', 'TOTAL GROSS TO DATE', fin.totalGrossPrev, fin.totalGrossPeriod, fin.totalGrossCum, 'total'),
      line(32, '06', pct(fin.advRecoveryRate * 100, 0) + ' Recovery of Advance Payment', fin.advRecoveredPrev, fin.advRecoveredPeriod, fin.advRecoveredCum, 'ded',
        fin.advPaid.cum > 0 && fin.advRemainingBalance < 0.005 ? 'Advance fully recovered' : ''),
      line(33, '07', pct(fin.retentionRate * 100) + ' Retention', fin.retentionPrev, fin.retentionPeriod, fin.retentionCum, 'ded',
        fin.retentionCap > 0 && fin.retentionCum >= fin.retentionCap - 0.005 ? 'Capped at ' + pct(fin.retentionCapRate * 100, 0) + ' of revised sum' : ''),
      line(34, '08', 'Liquidated Damages', fin.ld.prev, fin.ld.period, fin.ld.cum, 'ded'),
      line(35, '09', 'Other Deductions', fin.otherDeductionsPrev, fin.otherDeductionsPeriod, fin.otherDeductionsCum, 'ded'),
      line(36, 'B', 'TOTAL DEDUCTIONS TO DATE', fin.totalDedPrev, fin.totalDedPeriod, fin.totalDedCum, 'total ded'),
      // Payments already made are "to date" figures: cumulative column only.
      line(37, '10', 'Total Previous Interim Payments', null, null, fin.previousIpcPayments),
      line(38, '11', 'Total Other Payments', fin.otherPay.prev, fin.otherPay.period, fin.otherPay.cum),
      line(39, 'C', 'TOTAL PAYMENTS NET TO DATE', null, null, fin.totalPaymentsToDate, 'total'),
      // Amounts due are for this certificate only: THIS PERIOD column.
      line(40, '12', pct(fin.vatRate * 100, 0) + ' VAT', null, fin.vatPeriod, null, 'vat',
        Math.abs(fin.vatAdj.period) > 0.005 ? 'VAT on (A − B − C) excl. VAT adjustment' : 'VAT on (A − B − C)')
    ];

    const signoffs = c.signoffs || {};
    const team = (project.consultantTeam || []);

    return {
      sheetName: 'IPC-' + String(parseIpcNo(c.currentIpcNo)).padStart(3, '0'),
      header: { employer: s.employerName, consultant: project.consultant, contractor: c.companyName },
      application: {
        ipcNo: templateIpcNo(c.currentIpcNo),
        paymentType: c.paymentType || 'Interim Payment',
        taxInvoiceNo: c.taxInvoiceNo || '',
        invoiceDate: c.invoiceDate || '',
        periodOfValuation: monthYear(periodEnd),
        periodRange: c.valuationPeriod || '',
        valuationDate: c.valuationDate || periodEnd
      },
      contract: {
        contractorName: c.companyName,
        contractNumber: c.contractRef,
        scope: c.package,
        contractType: c.contractType || '',
        originalSum: num(c.originalContractSum),
        approvedVOs: fin.voApprovedTotal,
        revisedSum: fin.revisedContractSum,
        remainingSum: fin.revisedContractSum - fin.grossCum,
        commencement: project.commenceDate,
        completion: project.completeDate,
        duration: months > 0 ? months + ' Months' : '',
        beneficiary: c.beneficiaryName || c.companyName,
        vatRegNo: c.vatRegNo || '',
        bankName: c.bankName || '',
        iban: c.iban || '',
        advanceValue: fin.advTotalPaid,
        advanceValidUntil: c.advanceValidUntil || '',
        bondValue: num(c.performanceBondValue),
        bondValidUntil: c.performanceBondValidUntil || '',
        piInsurance: num(c.piInsuranceValue),
        tplInsurance: num(c.tplInsuranceValue),
        wcInsurance: num(c.wcInsuranceValue)
      },
      lines: lines,
      paymentDue: fin.paymentDue,
      postVatDeduction: fin.postVatDeduction,
      netPaymentDue: fin.netPaymentDue,
      amountInWords: amountToWords(fin.netPaymentDue),
      signatures: {
        consultantTitle: 'Valuation of this Payment Application Prepared by Consultant (' + project.consultant + ') Site Office',
        consultant: CONSULTANT_POSITIONS.map(function (pos, i) {
          return { position: pos, name: team[i] || '', date: signoffs.consultant || '' };
        }),
        siteTitle: 'Valuation of this Payment Application Reviewed by ' + s.employerName + ' Site Office',
        siteDepartment: s.siteOffice.department,
        site: s.siteOffice.signatories.map(function (x) { return { name: x.name, position: x.position, date: signoffs.siteOffice || '' }; }),
        homeTitle: 'Approval of this Payment Application Reviewed by ' + s.employerName + ' Home Office',
        homeDepartment: s.homeOffice.department,
        home: s.homeOffice.signatories.map(function (x) { return { name: x.name, position: x.position, date: signoffs.homeOffice || '' }; })
      }
    };
  }

  const api = { CONSULTANT_POSITIONS, defaultSettings, buildCertificate, templateIpcNo, MONTHS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IPCCert = api;
})(typeof window !== 'undefined' ? window : globalThis);
