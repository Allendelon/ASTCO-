/*
 * ASCTO IPC — export the certificate into the official Excel template.
 * Uses ExcelJS 4.4.0 (vendored at assets/vendor/exceljs-4.4.0.min.js, loaded on first export) and the
 * template embedded as base64 in assets/templates/ipc-template.js (works from file:// as well as http).
 * fillTemplate() is pure with respect to the DOM and is exercised by tests/export.test.js.
 */
(function (root) {
  'use strict';

  const EXCELJS_SRC = 'assets/vendor/exceljs-4.4.0.min.js';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // "28 Sep 2026" -> Date at UTC midnight (ExcelJS converts Dates to serials using UTC).
  function toDate(dmy) {
    const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(String(dmy || '').trim());
    if (!m) return null;
    const mi = MONTHS.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase());
    return mi < 0 ? null : new Date(Date.UTC(parseInt(m[3], 10), mi, parseInt(m[1], 10)));
  }

  function money(n) {
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }

  function setDate(ws, addr, dmy, fallback) {
    const d = toDate(dmy);
    const cell = ws.getCell(addr);
    cell.value = d || (dmy ? String(dmy) : (fallback || null));
  }

  // Optional amount: blank/zero prints "N/A" exactly like the template's placeholders.
  function setAmountOrNA(ws, addr, n, fmt) {
    const cell = ws.getCell(addr);
    if (n > 0) {
      cell.value = money(n);
      if (fmt) cell.numFmt = fmt;
    } else {
      cell.value = 'N/A';
    }
  }

  function fillTemplate(ws, model) {
    const a = model.application;
    const k = model.contract;
    const sig = model.signatures;

    ws.getCell('A1').value = model.header.employer;
    ws.getCell('D1').value = model.header.consultant;
    ws.getCell('M1').value = model.header.contractor;

    ws.getCell('F4').value = a.ipcNo;
    ws.getCell('L4').value = a.paymentType;
    ws.getCell('F5').value = a.taxInvoiceNo || null;
    setDate(ws, 'L5', a.invoiceDate);
    // Template formats F6 as "mmmm-yyyy": write the valuation period end as a date.
    setDate(ws, 'F6', String(a.periodRange).split(' to ').pop());
    setDate(ws, 'L6', a.valuationDate);

    ws.getCell('F8').value = k.contractorName;
    ws.getCell('L8').value = k.contractNumber;
    ws.getCell('F9').value = k.scope;
    ws.getCell('L9').value = k.contractType || null;
    ws.getCell('F10').value = money(k.originalSum);
    setDate(ws, 'L10', k.commencement);
    ws.getCell('F11').value = money(k.approvedVOs);
    setDate(ws, 'L11', k.completion);
    ws.getCell('F12').value = money(k.revisedSum);
    ws.getCell('L12').value = k.duration || null;          // text: the template's date format does not suit a duration
    ws.getCell('F13').value = money(k.remainingSum);
    ws.getCell('L13').value = k.beneficiary || null;
    ws.getCell('F14').value = k.vatRegNo ? String(k.vatRegNo) : null; // text, so the #,##0 format can't add separators
    ws.getCell('L14').value = k.bankName || null;
    ws.getCell('L15').value = k.iban || null;

    // ExcelJS 4.4.0 drops the template's accounting format on these two cells, so set it explicitly.
    setAmountOrNA(ws, 'F16', k.advanceValue, '#,##0.00');
    ws.getCell('J16').numFmt = 'dd-mmm-yyyy';
    setDate(ws, 'J16', k.advanceValidUntil, 'N/A');
    setAmountOrNA(ws, 'F17', k.bondValue, '#,##0.00');
    ws.getCell('J17').numFmt = 'dd-mmm-yyyy';
    setDate(ws, 'J17', k.bondValidUntil, 'N/A');
    setAmountOrNA(ws, 'F18', k.piInsurance, '#,##0.00');
    setAmountOrNA(ws, 'F19', k.tplInsurance, '#,##0.00');
    setAmountOrNA(ws, 'F20', k.wcInsurance, '#,##0.00');

    model.lines.forEach(function (l) {
      ws.getCell('C' + l.row).value = l.desc;
      ws.getCell('J' + l.row).value = l.last == null ? null : money(l.last);
      ws.getCell('K' + l.row).value = l.this == null ? null : money(l.this);
      ws.getCell('L' + l.row).value = l.cum == null ? null : money(l.cum);
      ws.getCell('M' + l.row).value = l.remark || null;
    });
    ['J', 'L'].forEach(function (col) { [41, 42, 43].forEach(function (r) { ws.getCell(col + r).value = null; }); });
    ws.getCell('K41').value = money(model.paymentDue);
    ws.getCell('M41').value = '(A − B − C) + VAT';
    ws.getCell('K42').value = money(model.postVatDeduction);
    ws.getCell('K43').value = money(model.netPaymentDue);
    ws.getCell('E44').value = model.amountInWords;

    ws.getCell('A46').value = sig.consultantTitle;
    ['D', 'G', 'K', 'L'].forEach(function (col, i) {
      const s = sig.consultant[i] || {};
      ws.getCell(col + '47').value = s.name || null;
      ws.getCell(col + '48').value = s.position || null;
      setDate(ws, col + '50', s.date);
    });
    ws.getCell('A51').value = sig.siteTitle;
    ws.getCell('D52').value = sig.siteDepartment || null;
    ws.getCell('A57').value = sig.homeTitle;
    ws.getCell('D58').value = sig.homeDepartment || null;
    [['site', 53, 54, 56], ['home', 59, 60, 62]].forEach(function (t) {
      ['D', 'K'].forEach(function (col, i) {
        const s = sig[t[0]][i] || {};
        ws.getCell(col + t[1]).value = s.name || null;
        ws.getCell(col + t[2]).value = s.position || null;
        setDate(ws, col + t[3], s.date);
      });
    });
    ws.name = model.sheetName;
    return ws;
  }

  /* ---------- Browser-only helpers ---------- */

  function loadExcelJS() {
    if (root.ExcelJS) return Promise.resolve(root.ExcelJS);
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = EXCELJS_SRC;
      s.onload = function () { root.ExcelJS ? resolve(root.ExcelJS) : reject(new Error('ExcelJS did not initialise')); };
      s.onerror = function () { reject(new Error('Could not load ' + EXCELJS_SRC)); };
      document.head.appendChild(s);
    });
  }

  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function exportCertificate(model, fileName) {
    if (!root.IPC_TEMPLATE_XLSX_B64) throw new Error('IPC template not loaded');
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(base64ToArrayBuffer(root.IPC_TEMPLATE_XLSX_B64));
    fillTemplate(wb.worksheets[0], model);
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  const api = { fillTemplate, exportCertificate, toDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IPCExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
