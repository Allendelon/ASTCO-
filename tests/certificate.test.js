// Certificate model + Excel template export. The export test needs ExcelJS 4.4.0 from npm
// (not a runtime dependency of the app, which uses the vendored browser build); it is skipped if absent.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const IPC = require('../assets/js/calc.js');
const Cert = require('../assets/js/certificate.js');
const Export = require('../assets/js/export-xlsx.js');

const project = {
  name: 'Test Project', consultant: 'Test Consultants', commenceDate: '15 Jan 2025', completeDate: '15 Jul 2027',
  consultantTeam: ['Eng. A', 'Eng. B', 'Eng. C', 'Eng. D']
};
const contractor = {
  companyName: 'Test Contractor Co.', package: 'Civil Works', contractRef: 'PKG-01', currentIpcNo: 'IPC-07',
  valuationPeriod: '01 Sep 2026 to 25 Sep 2026', invoiceDate: '28 Sep 2026', paymentType: 'Interim Payment',
  originalContractSum: 1000000, advancePaymentOriginal: 100000, advanceRecoveryRate: 0.1,
  retentionRate: 0.1, retentionCapRate: 0.05, vatRate: 0.15, vatRegNo: '300123456700003',
  boqItems: [{ rate: 1000, contractQty: 1000, prevQty: 100, thisQty: 50 }], variations: [], mos: [],
  signoffs: { consultant: '29 Sep 2026', siteOffice: null, homeOffice: null }
};

test('certificate lines follow the template rows and reconcile', () => {
  const fin = IPC.calculateContractorFinancials(contractor);
  const m = Cert.buildCertificate(Cert.defaultSettings(), project, contractor, fin);
  assert.deepEqual(m.lines.map(l => l.row), [23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
  const byRow = Object.fromEntries(m.lines.map(l => [l.row, l]));
  for (const l of m.lines) if (l.last != null && l.this != null) assert.ok(Math.abs(l.last + l.this - l.cum) < 0.005, 'row ' + l.row);
  assert.ok(Math.abs(byRow[31].cum - byRow[36].cum - byRow[39].cum - fin.dueExVat) < 0.005, 'A − B − C = due ex-VAT');
  assert.equal(m.application.ipcNo, 'IPC 07');
  assert.equal(m.contract.scope, 'Test Project – Civil Works', 'project name carried in Contract Name/Scope');
  assert.equal(m.application.periodOfValuation, 'September-2026');
  assert.equal(m.signatures.consultant[3].name, 'Eng. D');
  assert.equal(m.signatures.consultant[0].date, '29 Sep 2026');
  assert.equal(m.signatures.site[0].date, '');
});

let ExcelJS = null;
try { ExcelJS = require('exceljs'); } catch { /* optional */ }

test('fills the official Excel template', { skip: !ExcelJS && 'exceljs not installed (npm i --no-save exceljs@4.4.0)' }, async () => {
  const fin = IPC.calculateContractorFinancials(contractor);
  const m = Cert.buildCertificate(Cert.defaultSettings(), project, contractor, fin);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(__dirname, '../assets/templates/ipc-template.xlsx'));
  Export.fillTemplate(wb.worksheets[0], m);
  const buf = await wb.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  const ws = wb2.worksheets[0];
  assert.equal(ws.name, 'IPC-007');
  assert.equal(ws.getCell('A2').value, 'CONTRACTOR PAYMENT CERTIFICATE');
  assert.equal(ws.getCell('F4').value, 'IPC 07');
  assert.equal(ws.getCell('F14').value, '300123456700003', 'VAT number stays text');
  assert.ok(ws.getCell('L10').value instanceof Date, 'commencement date is a real date');
  assert.equal(ws.getCell('L10').value.toISOString().slice(0, 10), '2025-01-15');
  assert.equal(ws.getCell('L31').value, Math.round(fin.totalGrossCum * 100) / 100);
  assert.equal(ws.getCell('K43').value, Math.round(fin.netPaymentDue * 100) / 100);
  assert.equal(ws.getCell('E44').value, IPC.amountToWords(fin.netPaymentDue));
  assert.equal(ws.getCell('D47').value, 'Eng. A');
  assert.ok(ws.getCell('D50').value instanceof Date, 'consultant sign-off date');
  assert.equal(ws.getCell('D53').value, 'Arif Jamal Ansari');
  assert.equal(ws.getCell('F16').value, 100000);
  assert.equal(ws.getCell('F16').numFmt, '#,##0.00', 'advance value keeps thousands separators');
  assert.equal(ws.getCell('L31').numFmt, '#,##0.00', 'template number formats preserved');
  assert.equal(ws.getCell('F17').value, 'N/A');
});
