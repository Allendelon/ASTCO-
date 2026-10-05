/*
 * ASCTO IPC — application controller (state, persistence, rendering, actions).
 * Depends on: calc.js (window.IPC), data.js (window.IPC_SEED), Chart.js 4.x (window.Chart, optional).
 */
(function () {
  'use strict';

  const {
    num, formatSAR, formatDeduction, formatNumber, formatIpcNo, parseIpcNo,
    addMonths, monthsBetween, shortMonth, amountToWords, calculateContractorFinancials: calc, logisticShare
  } = window.IPC;

  const STORAGE_KEY = 'ascto-ipc-state-v1';
  const SECTOR_COLORS = {
    'Mixed-Use': 'bg-indigo-100 text-indigo-800 border-indigo-200',
    'Plants & Utilities': 'bg-teal-100 text-teal-800 border-teal-200',
    'Hospitality': 'bg-purple-100 text-purple-800 border-purple-200',
    'Malls & Retail': 'bg-pink-100 text-pink-800 border-pink-200',
    'Residential': 'bg-emerald-100 text-emerald-800 border-emerald-200'
  };
  const STATUS_META = {
    'Under Review': { badge: 'bg-amber-100 text-amber-800', label: 'Under Review' },
    'Approved': { badge: 'bg-emerald-100 text-emerald-800', label: 'Approved' },
    'Returned': { badge: 'bg-rose-100 text-rose-800', label: 'Returned with Snags' }
  };
  const TONE_DOT = { blue: 'bg-blue-500', amber: 'bg-amber-500', green: 'bg-emerald-500', red: 'bg-rose-500', gold: 'bg-midad-gold' };

  let state = null;
  let activeTab = 'contractors';
  let activeSectorFilter = 'all';
  let scurveChart = null;
  let cashflowChart = null;
  let storageWarned = false;

  /* ================= Utilities ================= */

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function $(id) { return document.getElementById(id); }

  function setTxt(id, val) {
    const el = $(id);
    if (el) el.textContent = val;
  }

  function nextId(list) {
    return (list || []).reduce(function (m, x) { return Math.max(m, num(x.id)); }, 0) + 1;
  }

  // Built manually: en-GB toLocaleDateString renders September as "Sept" on current ICU, which breaks parsing.
  function todayDMY() {
    const d = new Date();
    return window.IPC.formatDMY({ d: d.getDate(), m: d.getMonth(), y: d.getFullYear() });
  }

  function nowStamp() {
    const d = new Date();
    return todayDMY() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // Reads an optional numeric form field: blank -> fallback, otherwise the number (0 is a valid entry).
  function optionalNumber(id, fallback) {
    const raw = ($(id).value || '').trim();
    if (raw === '') return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  /* ================= State & persistence ================= */

  function seedHistory(c) {
    const fin = calc(c);
    const prior = parseIpcNo(c.currentIpcNo) - 1;
    c.history = [];
    if (prior <= 0 || fin.grossPrev <= 0) return;

    // Split the previously certified gross across prior IPCs along an S-shaped profile.
    // The final prior row lands exactly on the "Previous" column, so the ledger reconciles.
    const worksShare = (fin.boqPrevTotal + fin.voPrevTotal) / fin.grossPrev;
    const periodStart = String(c.valuationPeriod || '').split(' to ')[0];
    let last = { gross: 0, ret: 0, adv: 0, oth: 0 };
    for (let k = 1; k <= prior; k++) {
      const share = k === prior ? 1 : 0.5 * (k / prior) + 0.5 * logisticShare(k / prior);
      const gross = fin.grossPrev * share;
      const cum = {
        gross: gross,
        ret: Math.min(gross * worksShare * fin.retentionRate, fin.retentionCap),
        adv: Math.min(gross * fin.advRecoveryRate, fin.advTotalPaid),
        oth: k === prior ? fin.otherDeductionsPrev : 0
      };
      const row = {
        ipcNo: formatIpcNo(k),
        period: shortMonth(addMonths(periodStart, k - prior - 1)),
        gross: cum.gross - last.gross,
        retention: cum.ret - last.ret,
        advance: cum.adv - last.adv,
        other: cum.oth - last.oth
      };
      row.net = row.gross - row.retention - row.advance - row.other;
      row.vat = row.net * fin.vatRate;
      row.total = row.net + row.vat;
      row.status = 'Disbursed';
      c.history.push(row);
      last = cum;
    }
  }

  function seedAudit(c) {
    c.audit = [
      { ts: c.issueDate, tone: 'blue', title: c.currentIpcNo + ' valuation cycle registered', detail: 'Payment application submitted by ' + c.companyName + ' and verified by quantity surveyors.' }
    ];
    if (c.approvalStatus === 'Approved') {
      c.audit.unshift({ ts: c.issueDate, tone: 'green', title: 'Final commercial approval granted', detail: 'Certificate transmitted to Finance & Treasury for payment release.' });
    }
  }

  function normalizeContractor(c) {
    c.boqItems = c.boqItems || [];
    c.variations = c.variations || [];
    c.mos = c.mos || [];
    c.variations.forEach(function (v) { if (v.prevPct == null) v.prevPct = 0; });
    c.mos.forEach(function (m) { if (m.prevQty == null) m.prevQty = 0; });
    if (c.approvalStatus === 'Flagged') c.approvalStatus = 'Returned';
    if (!STATUS_META[c.approvalStatus]) c.approvalStatus = 'Under Review';
    if (!Array.isArray(c.history)) seedHistory(c);
    if (!Array.isArray(c.audit)) seedAudit(c);
  }

  function freshState() {
    const seed = JSON.parse(JSON.stringify(window.IPC_SEED));
    const s = { version: 1, approver: seed.approver, projects: seed.projects, activeProjectKey: Object.keys(seed.projects)[0] };
    Object.values(s.projects).forEach(function (p) { p.contractors.forEach(normalizeContractor); });
    return s;
  }

  function isValidState(s) {
    return s && typeof s === 'object' && s.projects && typeof s.projects === 'object' && Object.keys(s.projects).length > 0;
  }

  function loadState() {
    let saved = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {
      saved = null;
    }
    if (!isValidState(saved)) return freshState();
    Object.values(saved.projects).forEach(function (p) { (p.contractors = p.contractors || []).forEach(normalizeContractor); });
    if (!saved.projects[saved.activeProjectKey]) saved.activeProjectKey = Object.keys(saved.projects)[0];
    if (!saved.approver) saved.approver = window.IPC_SEED.approver;
    return saved;
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setTxt('saveIndicator', 'Saved locally ' + nowStamp().split(' ').pop());
    } catch {
      setTxt('saveIndicator', 'Not saved (storage unavailable)');
      if (!storageWarned) {
        storageWarned = true;
        showToast('Browser storage is unavailable — changes will be lost on reload. Use Export to keep a copy.', 'warning');
      }
    }
  }

  function commit() {
    saveState();
    renderApp();
  }

  function activeProject() {
    return state.projects[state.activeProjectKey];
  }

  function activeContractor() {
    const p = activeProject();
    if (!p || !p.contractors.length) return null;
    let c = p.contractors.find(function (k) { return k.id === p.activeContractorId; });
    if (!c) {
      c = p.contractors[0];
      p.activeContractorId = c.id;
    }
    return c;
  }

  function addAudit(c, tone, title, detail) {
    c.audit.unshift({ ts: nowStamp(), tone: tone, title: title, detail: detail });
  }

  /* ================= Rendering ================= */

  function renderSelectors() {
    const ps = $('projectSelector');
    ps.innerHTML = Object.values(state.projects).map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === state.activeProjectKey ? ' selected' : '') + '>' +
        esc(p.name) + ' (' + esc(p.sector) + ')</option>';
    }).join('');

    const p = activeProject();
    const cs = $('contractorSelector');
    cs.innerHTML = p.contractors.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === p.activeContractorId ? ' selected' : '') + '>' +
        esc(c.companyName) + ' (' + esc(c.package) + ')</option>';
    }).join('');
  }

  function renderApp() {
    renderSelectors();
    const proj = activeProject();
    const c = activeContractor();
    renderContractorsTab();
    if (!c) {
      $('noContractorNotice').hidden = false;
      return;
    }
    $('noContractorNotice').hidden = true;
    const fin = calc(c);

    renderKpis(c, fin);
    renderCertificate(proj, c, fin);
    renderBoqTable(c, fin);
    renderVoTable(c);
    renderMosTable(c, fin);
    renderDeductions(c, fin);
    renderWorkflow(c);
    renderAnalyticsSummary(fin);
    if (activeTab === 'analytics') renderCharts(proj, c, fin);
  }

  function renderKpis(c, fin) {
    const meta = STATUS_META[c.approvalStatus];
    setTxt('kpiRevisedContract', formatSAR(fin.revisedContractSum));
    setTxt('kpiOriginalContract', 'Base: ' + formatSAR(c.originalContractSum));
    setTxt('kpiGrossCertified', formatSAR(fin.grossCum));
    setTxt('kpiPercentCompleted', fin.progressPercent.toFixed(2) + '%');
    setTxt('kpiNetPayable', formatSAR(fin.finalDuePeriod));
    setTxt('kpiVatAmount', (fin.vatRate * 100).toFixed(0) + '% VAT: ' + formatSAR(fin.vatPeriod));
    setTxt('kpiIpcNumber', c.currentIpcNo);
    const badge = $('kpiStatusBadge');
    badge.textContent = meta.label;
    badge.className = 'text-xs px-2 py-0.5 rounded-full font-medium ' + meta.badge;
    const cutoff = String(c.valuationPeriod || '').split(' to ')[1] || c.valuationPeriod;
    setTxt('kpiValuationDate', 'Cut-off: ' + cutoff);
  }

  function renderCertificate(proj, c, fin) {
    setTxt('certIpcNoDisplay', c.currentIpcNo);
    setTxt('certValuationPeriod', c.valuationPeriod);
    setTxt('certIssueDate', c.issueDate);
    setTxt('certProjectName', proj.name);
    setTxt('certClientName', proj.client);
    setTxt('certConsultantName', proj.consultant);
    setTxt('certContractorName', c.companyName + ' (' + c.package + ')');
    setTxt('certContractRef', c.contractRef);
    setTxt('certPackageTrade', c.tradeCategory);
    setTxt('certContractDates', proj.commenceDate + ' to ' + proj.completeDate);

    setTxt('certContractorSignCompany', c.companyName);
    setTxt('certContractorSignName', c.repName);
    setTxt('certContractorSignRole', c.repRole);
    setTxt('certContractorSignSig', String(c.repName || '').split(' ').slice(-1)[0]);
    setTxt('certEngineerCompany', proj.consultant);
    setTxt('certEngineerName', proj.engineerName || '—');
    setTxt('certEngineerRole', proj.engineerRole || 'Resident Engineer');
    setTxt('certEngineerSig', String(proj.engineerName || '').replace(/,.*$/, '').replace(/^(Dr\.|Eng\.)\s*/, ''));
    setTxt('certApproverName', state.approver.name);
    setTxt('certApproverRole', state.approver.role);
    setTxt('certApproverSig', state.approver.name.replace(/^(Dr\.|Eng\.)\s*/, ''));

    const meta = STATUS_META[c.approvalStatus];
    const ab = $('midadApprovalBadge');
    ab.textContent = c.approvalStatus === 'Approved' ? 'Authorized' : meta.label;
    ab.className = 'text-xs px-2 py-0.5 rounded font-semibold ' + meta.badge;
    $('approverSigBlock').classList.toggle('opacity-30', c.approvalStatus !== 'Approved');

    const rows = [
      ['valRow1', fin.boqCumTotal, fin.boqPrevTotal, fin.boqPeriodTotal],
      ['valRow2', fin.voCumTotal, fin.voPrevTotal, fin.voPeriodTotal],
      ['valRow3', fin.mosCumTotal, fin.mosPrevTotal, fin.mosPeriodTotal],
      ['valGross', fin.grossCum, fin.grossPrev, fin.grossPeriod],
      ['valNet', fin.netCum, fin.netPrev, fin.netPeriod],
      ['valVat', fin.vatCum, fin.vatPrev, fin.vatPeriod],
      ['valTotalIncVat', fin.finalDueCum, fin.finalDuePrev, fin.finalDuePeriod]
    ];
    rows.forEach(function (r) {
      setTxt(r[0] + 'Cum', formatSAR(r[1]));
      setTxt(r[0] + 'Prev', formatSAR(r[2]));
      setTxt(r[0] + 'Period', formatSAR(r[3]));
    });
    const dedRows = [
      ['valRet', fin.retentionCum, fin.retentionPrev, fin.retentionPeriod],
      ['valAdv', fin.advRecoveredCum, fin.advRecoveredPrev, fin.advRecoveredPeriod],
      ['valOth', fin.otherDeductionsCum, fin.otherDeductionsPrev, fin.otherDeductionsPeriod],
      ['valDedTotal', fin.totalDedCum, fin.totalDedPrev, fin.totalDedPeriod]
    ];
    dedRows.forEach(function (r) {
      setTxt(r[0] + 'Cum', formatDeduction(r[1]));
      setTxt(r[0] + 'Prev', formatDeduction(r[2]));
      setTxt(r[0] + 'Period', formatDeduction(r[3]));
    });

    setTxt('valRetentionCapText', formatSAR(fin.retentionCap));
    setTxt('valRetRateText', (fin.retentionRate * 100).toFixed(0) + '%');
    setTxt('valRetCapRateText', (fin.retentionCapRate * 100).toFixed(0) + '%');
    setTxt('valAdvRateText', (fin.advRecoveryRate * 100).toFixed(0) + '%');
    setTxt('valVatRateText', (fin.vatRate * 100).toFixed(0) + '%');
    setTxt('valVatRateText2', (fin.vatRate * 100).toFixed(0) + '%');
    const advPct = fin.advTotalPaid > 0 ? (fin.advRecoveredCum / fin.advTotalPaid) * 100 : 0;
    setTxt('valAdvanceRecPct', advPct.toFixed(1) + '%');
    setTxt('certAmountInWords', amountToWords(fin.finalDuePeriod));
    $('negativeCertNotice').hidden = fin.finalDuePeriod >= 0;
  }

  function renderBoqTable(c, fin) {
    const tbody = $('boqTableBody');
    tbody.innerHTML = c.boqItems.map(function (item) {
      const prev = num(item.prevQty);
      const total = prev + num(item.thisQty);
      const cq = num(item.contractQty);
      const pct = cq > 0 ? (total / cq) * 100 : 0;
      const overrun = cq > 0 && total > cq + 1e-9;
      const pctClass = overrun ? 'bg-rose-100 text-rose-800' : pct >= 99.9 ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-50 text-blue-700';
      return '<tr class="hover:bg-slate-50 transition' + (overrun ? ' bg-rose-50/40' : '') + '">' +
        '<td class="py-2.5 px-3 font-semibold text-slate-800">' + esc(item.code) + '</td>' +
        '<td class="py-2.5 px-3 font-medium text-slate-900">' + esc(item.desc) + '</td>' +
        '<td class="py-2.5 px-2 text-center text-slate-500 font-mono">' + esc(item.unit) + '</td>' +
        '<td class="py-2.5 px-3 text-right text-slate-700">' + formatNumber(cq) + '</td>' +
        '<td class="py-2.5 px-3 text-right text-slate-700">' + formatNumber(num(item.rate)) + '</td>' +
        '<td class="py-2.5 px-3 text-right font-medium text-slate-800">' + formatNumber(cq * num(item.rate)) + '</td>' +
        '<td class="py-2.5 px-3 text-right text-slate-500">' + formatNumber(prev) + '</td>' +
        '<td class="py-2 px-2 text-right bg-amber-50/50">' +
          '<input type="number" step="any" value="' + esc(item.thisQty) + '" data-action="boq-qty" data-id="' + esc(item.id) + '" aria-label="This period quantity for ' + esc(item.code) + '"' +
          ' class="w-24 px-2 py-1 text-right text-xs font-bold text-amber-900 bg-white border border-amber-300 rounded shadow-sm focus:outline-none focus:ring-2 focus:ring-amber-500">' +
        '</td>' +
        '<td class="py-2.5 px-3 text-right font-bold text-slate-900">' + formatNumber(total) + '</td>' +
        '<td class="py-2.5 px-2 text-center"><span class="inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold ' + pctClass + '"' +
          (overrun ? ' title="Exceeds contract quantity — requires remeasurement or VO"' : '') + '>' + pct.toFixed(1) + '%' + (overrun ? ' ▲' : '') + '</span></td>' +
        '<td class="py-2.5 px-3 text-right font-bold text-slate-900 bg-slate-50/40">' + formatSAR(total * num(item.rate)) + '</td>' +
        '<td class="py-2.5 px-2 text-center no-print"><button data-action="boq-del" data-id="' + esc(item.id) + '" class="text-rose-400 hover:text-rose-600 p-1" title="Delete item" aria-label="Delete ' + esc(item.code) + '">✕</button></td>' +
        '</tr>';
    }).join('') || emptyRow(12, 'No BOQ items. Add one to start measuring.');

    setTxt('boqFooterContractTotal', formatSAR(fin.boqContractTotal));
    setTxt('boqFooterCertifiedTotal', formatSAR(fin.boqCumTotal));
    filterBoqTable();
  }

  function renderVoTable(c) {
    let totalApproved = 0, totalCertified = 0;
    $('voTableBody').innerHTML = c.variations.map(function (vo) {
      const approved = vo.status === 'Approved';
      const certified = approved ? num(vo.approvedSum) * num(vo.progressPct) / 100 : 0;
      if (approved) {
        totalApproved += num(vo.approvedSum);
        totalCertified += certified;
      }
      return '<tr class="hover:bg-slate-50' + (approved ? '' : ' text-slate-400') + '">' +
        '<td class="py-2.5 px-3 font-bold text-slate-800">' + esc(vo.code) + '</td>' +
        '<td class="py-2.5 px-3 font-medium">' + esc(vo.desc) + '</td>' +
        '<td class="py-2.5 px-3 text-center text-slate-500">' + esc(vo.date) + '</td>' +
        '<td class="py-2.5 px-3 text-right font-medium">' + formatSAR(num(vo.approvedSum)) + '</td>' +
        '<td class="py-2.5 px-3 text-center text-slate-500">' + formatNumber(num(vo.prevPct), 0) + '%</td>' +
        '<td class="py-2.5 px-3 text-center"><input type="number" min="0" max="100" step="any" value="' + esc(vo.progressPct) + '" data-action="vo-pct" data-id="' + esc(vo.id) + '" aria-label="Progress for ' + esc(vo.code) + '"' +
          ' class="w-16 px-1.5 py-0.5 text-center text-xs font-semibold border rounded border-slate-300"> %</td>' +
        '<td class="py-2.5 px-3 text-right font-bold text-slate-900">' + formatSAR(certified) + '</td>' +
        '<td class="py-2.5 px-3 text-center"><button data-action="vo-status" data-id="' + esc(vo.id) + '" title="Toggle Approved / Pending" class="px-2 py-0.5 rounded text-[10px] font-bold ' +
          (approved ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600') + '">' + esc(vo.status) + '</button></td>' +
        '<td class="py-2.5 px-2 text-center no-print"><button data-action="vo-del" data-id="' + esc(vo.id) + '" class="text-rose-400 hover:text-rose-600 p-1" aria-label="Delete ' + esc(vo.code) + '">✕</button></td>' +
        '</tr>';
    }).join('') || emptyRow(9, 'No variation orders registered.');
    setTxt('voTotalApprovedSum', formatSAR(totalApproved));
    setTxt('voTotalCertifiedSum', formatSAR(totalCertified));
  }

  function renderMosTable(c, fin) {
    $('mosTableBody').innerHTML = c.mos.map(function (m) {
      const inv = num(m.qty) * num(m.invoiceRate);
      return '<tr class="hover:bg-slate-50">' +
        '<td class="py-2.5 px-3 font-bold text-slate-800">' + esc(m.code) + '</td>' +
        '<td class="py-2.5 px-3 text-slate-800 font-medium">' + esc(m.desc) + '</td>' +
        '<td class="py-2.5 px-2 text-center text-slate-500">' + esc(m.unit) + '</td>' +
        '<td class="py-2.5 px-3 text-right text-slate-500">' + formatNumber(num(m.prevQty)) + '</td>' +
        '<td class="py-2 px-2 text-right bg-amber-50/50"><input type="number" min="0" step="any" value="' + esc(m.qty) + '" data-action="mos-qty" data-id="' + esc(m.id) + '" aria-label="Stored quantity for ' + esc(m.code) + '"' +
          ' class="w-24 px-2 py-1 text-right text-xs font-bold text-amber-900 bg-white border border-amber-300 rounded"></td>' +
        '<td class="py-2.5 px-3 text-right">' + formatNumber(num(m.invoiceRate)) + '</td>' +
        '<td class="py-2.5 px-3 text-right font-medium">' + formatSAR(inv) + '</td>' +
        '<td class="py-2.5 px-3 text-center font-semibold text-amber-800">' + formatNumber(num(m.certPct), 0) + '%</td>' +
        '<td class="py-2.5 px-3 text-right font-bold text-slate-900">' + formatSAR(inv * num(m.certPct) / 100) + '</td>' +
        '<td class="py-2.5 px-2 text-center no-print"><button data-action="mos-del" data-id="' + esc(m.id) + '" class="text-rose-400 hover:text-rose-600 p-1" aria-label="Delete ' + esc(m.code) + '">✕</button></td>' +
        '</tr>';
    }).join('') || emptyRow(10, 'No materials on site registered.');
    setTxt('mosInvoiceTotal', formatSAR(fin.mosInvoiceTotal));
    setTxt('mosCertifiedTotal', formatSAR(fin.mosCumTotal));
  }

  function emptyRow(cols, msg) {
    return '<tr><td colspan="' + cols + '" class="py-6 text-center text-slate-400 text-xs">' + esc(msg) + '</td></tr>';
  }

  function renderDeductions(c, fin) {
    const advPct = fin.advTotalPaid > 0 ? (fin.advRecoveredCum / fin.advTotalPaid) * 100 : 0;
    setTxt('advCardTotalPaid', formatSAR(fin.advTotalPaid));
    setTxt('advCardCumRecovered', formatSAR(fin.advRecoveredCum));
    setTxt('advCardBalance', formatSAR(fin.advRemainingBalance));
    setTxt('advCardRate', (fin.advRecoveryRate * 100).toFixed(0) + '% deducted from each IPC gross');
    setTxt('advCardPct', advPct.toFixed(1) + '% Complete');
    $('advCardProgressBar').style.width = Math.min(100, advPct) + '%';

    const retPct = fin.retentionCap > 0 ? (fin.retentionCum / fin.retentionCap) * 100 : 0;
    setTxt('retCardRate', (fin.retentionRate * 100).toFixed(0) + '% per certificate');
    setTxt('retCardCapLabel', 'Maximum Retention Limit (' + (fin.retentionCapRate * 100).toFixed(0) + '% Contract Sum):');
    setTxt('retCardCapLimit', formatSAR(fin.retentionCap));
    setTxt('retCardCumWithheld', formatSAR(fin.retentionCum));
    setTxt('retCardRemainingCap', formatSAR(Math.max(0, fin.retentionCap - fin.retentionCum)));
    setTxt('retCardPct', retPct.toFixed(1) + '% of Cap');
    $('retCardProgressBar').style.width = Math.min(100, retPct) + '%';

    setTxt('othPrevDisplay', formatSAR(fin.otherDeductionsPrev));
    const othInput = $('othPeriodInput');
    if (document.activeElement !== othInput) othInput.value = round(fin.otherDeductionsPeriod);
    setTxt('othCumDisplay', formatSAR(fin.otherDeductionsCum));

    const hist = c.history.map(function (h, idx) {
      const paid = h.status === 'Disbursed';
      return '<tr class="hover:bg-slate-50">' +
        '<td class="py-2.5 px-3 font-bold">' + esc(h.ipcNo) + '</td>' +
        '<td class="py-2.5 px-3 text-slate-600">' + esc(h.period) + '</td>' +
        '<td class="py-2.5 px-3 text-right">' + formatSAR(h.gross) + '</td>' +
        '<td class="py-2.5 px-3 text-right text-rose-600">' + formatSAR(h.retention) + '</td>' +
        '<td class="py-2.5 px-3 text-right text-rose-600">' + formatSAR(h.advance) + '</td>' +
        '<td class="py-2.5 px-3 text-right text-rose-600">' + formatSAR(h.other) + '</td>' +
        '<td class="py-2.5 px-3 text-right font-medium">' + formatSAR(h.net) + '</td>' +
        '<td class="py-2.5 px-3 text-right">' + formatSAR(h.vat) + '</td>' +
        '<td class="py-2.5 px-3 text-right font-bold text-slate-900">' + formatSAR(h.total) + '</td>' +
        '<td class="py-2.5 px-3 text-center">' + (paid
          ? '<span class="px-2 py-0.5 rounded-full text-[10px] bg-emerald-100 text-emerald-800 font-semibold">Disbursed</span>'
          : '<button data-action="hist-paid" data-idx="' + idx + '" class="px-2 py-0.5 rounded-full text-[10px] bg-blue-100 text-blue-800 font-semibold hover:bg-blue-200" title="Mark as paid">Certified · Mark Paid</button>') +
        '</td></tr>';
    }).join('');
    const current = '<tr class="bg-amber-50/50 font-medium">' +
      '<td class="py-2.5 px-3 font-bold text-amber-900">' + esc(c.currentIpcNo) + ' (Active)</td>' +
      '<td class="py-2.5 px-3 text-slate-700">' + esc(shortMonth(String(c.valuationPeriod).split(' to ')[0])) + '</td>' +
      '<td class="py-2.5 px-3 text-right">' + formatSAR(fin.grossPeriod) + '</td>' +
      '<td class="py-2.5 px-3 text-right text-rose-600">' + formatSAR(fin.retentionPeriod) + '</td>' +
      '<td class="py-2.5 px-3 text-right text-rose-600">' + formatSAR(fin.advRecoveredPeriod) + '</td>' +
      '<td class="py-2.5 px-3 text-right text-rose-600">' + formatSAR(fin.otherDeductionsPeriod) + '</td>' +
      '<td class="py-2.5 px-3 text-right font-bold text-slate-900">' + formatSAR(fin.netPeriod) + '</td>' +
      '<td class="py-2.5 px-3 text-right">' + formatSAR(fin.vatPeriod) + '</td>' +
      '<td class="py-2.5 px-3 text-right font-bold text-amber-900">' + formatSAR(fin.finalDuePeriod) + '</td>' +
      '<td class="py-2.5 px-3 text-center"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ' + STATUS_META[c.approvalStatus].badge + '">' + esc(STATUS_META[c.approvalStatus].label) + '</span></td>' +
      '</tr>';
    $('histTableBody').innerHTML = hist + current;
  }

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  function renderWorkflow(c) {
    const s = c.approvalStatus;
    const icon3 = $('stage3Icon');
    const icon4 = $('stage4Icon');
    if (s === 'Approved') {
      icon3.className = 'w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-sm shrink-0';
      icon3.textContent = '✓';
      icon4.className = 'w-8 h-8 rounded-full bg-amber-500 text-white flex items-center justify-center font-bold text-sm shrink-0';
      setTxt('stage4Status', 'Ready for Tax Invoice & Payment');
    } else {
      icon3.className = 'w-8 h-8 rounded-full ' + (s === 'Returned' ? 'bg-rose-600' : 'bg-amber-500') + ' text-white flex items-center justify-center font-bold text-sm shrink-0';
      icon3.textContent = s === 'Returned' ? '!' : '3';
      icon4.className = 'w-8 h-8 rounded-full bg-slate-300 text-slate-600 flex items-center justify-center font-bold text-sm shrink-0';
      setTxt('stage4Status', 'Awaiting Authorization');
    }
    setTxt('stage3Status', STATUS_META[s].label);
    $('stage3Status').className = 'inline-block mt-2 text-[10px] px-2 py-0.5 rounded font-semibold ' + STATUS_META[s].badge;
    $('btnApprove').disabled = s === 'Approved';
    $('btnReturn').disabled = s === 'Returned';

    $('auditTrailContainer').innerHTML = c.audit.map(function (a) {
      return '<div class="flex items-start space-x-3 p-3 bg-slate-50 rounded-lg text-xs border border-slate-200">' +
        '<span class="w-2.5 h-2.5 rounded-full ' + (TONE_DOT[a.tone] || TONE_DOT.blue) + ' mt-1 shrink-0"></span>' +
        '<div class="flex-1"><div class="flex justify-between gap-3 font-semibold text-slate-800"><span>' + esc(a.title) + '</span>' +
        '<span class="text-slate-400 whitespace-nowrap">' + esc(a.ts) + '</span></div>' +
        '<p class="text-slate-600 mt-0.5">' + esc(a.detail) + '</p></div></div>';
    }).join('');
  }

  function renderAnalyticsSummary(fin) {
    setTxt('analyticsGrossCertified', 'SAR ' + (fin.grossCum / 1e6).toFixed(2) + 'M');
    setTxt('analyticsGrossPct', fin.progressPercent.toFixed(1) + '% of contract');
    setTxt('analyticsDeductions', 'SAR ' + ((fin.retentionCum + fin.advRecoveredCum) / 1e6).toFixed(2) + 'M');
    const uncertified = Math.max(0, fin.revisedContractSum - fin.grossCum);
    setTxt('analyticsUncertifiedScope', 'SAR ' + (uncertified / 1e6).toFixed(2) + 'M');
    setTxt('analyticsUncertifiedPct', fin.revisedContractSum > 0 ? ((uncertified / fin.revisedContractSum) * 100).toFixed(1) + '% remaining' : '0% remaining');
  }

  function renderContractorsTab() {
    const proj = activeProject();
    setTxt('hubProjectName', proj.name);
    let committed = 0, certified = 0, retention = 0, due = 0;
    proj.contractors.forEach(function (c) {
      const f = calc(c);
      committed += f.revisedContractSum;
      certified += f.grossCum;
      retention += f.retentionCum;
      due += f.finalDuePeriod;
    });

    const visible = proj.contractors.filter(function (c) {
      return activeSectorFilter === 'all' || c.sector === activeSectorFilter;
    });
    setTxt('visibleContractorsCount', String(visible.length));

    const cards = [];
    const rows = [];
    visible.forEach(function (c) {
      const f = calc(c);
      const isCurrent = c.id === proj.activeContractorId;
      const badge = SECTOR_COLORS[c.sector] || 'bg-amber-100 text-amber-800 border-amber-200';
      const st = STATUS_META[c.approvalStatus];
      cards.push(
        '<div class="rounded-xl p-5 border transition-all duration-200 ' + (isCurrent ? 'bg-amber-50/60 border-midad-gold shadow-md ring-2 ring-midad-gold/30' : 'bg-white border-slate-200 shadow-sm hover:border-slate-300') + '">' +
        '<div class="flex justify-between items-start gap-2"><div class="min-w-0">' +
        '<div class="flex items-center gap-1.5 flex-wrap"><span class="text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider ' + badge + '">' + esc(c.sector || 'General') + '</span>' +
        '<span class="text-[10px] font-semibold text-slate-500">' + esc(c.tradeCategory) + '</span></div>' +
        '<h4 class="font-bold text-slate-900 text-sm mt-2">' + esc(c.companyName) + '</h4>' +
        '<p class="text-xs text-slate-600 font-medium">' + esc(c.package) + '</p>' +
        '<p class="text-[11px] text-slate-400 mt-0.5 font-mono">' + esc(c.contractRef) + '</p></div>' +
        '<span class="text-xs px-2 py-0.5 rounded font-semibold whitespace-nowrap ' + st.badge + '">' + esc(st.label) + '</span></div>' +
        '<div class="mt-4 pt-3 border-t border-slate-200 grid grid-cols-2 gap-2 text-xs">' +
        '<div><span class="text-slate-500 block text-[10px] uppercase font-semibold">Revised Sum</span><span class="font-bold text-slate-800">' + formatSAR(f.revisedContractSum) + '</span></div>' +
        '<div><span class="text-slate-500 block text-[10px] uppercase font-semibold">Active Cycle Due</span><span class="font-bold text-midad-gold">' + formatSAR(f.finalDuePeriod) + '</span></div></div>' +
        '<div class="mt-3"><div class="flex justify-between text-[11px] font-semibold text-slate-600 mb-1"><span>Progress: ' + f.progressPercent.toFixed(1) + '%</span><span>' + esc(c.currentIpcNo) + '</span></div>' +
        '<div class="w-full h-2 bg-slate-200 rounded-full overflow-hidden"><div class="h-full bg-midad-gold rounded-full" style="width:' + Math.min(100, Math.max(0, f.progressPercent)) + '%"></div></div></div>' +
        '<div class="mt-4 pt-3 border-t border-slate-200 flex justify-between items-center gap-2 text-xs">' +
        '<span class="text-slate-500 truncate">Lead: <strong>' + esc(c.repName) + '</strong></span>' +
        '<button data-action="open-ipc" data-id="' + esc(c.id) + '" class="px-3 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded font-medium transition shadow-sm whitespace-nowrap">' + (isCurrent ? 'Active IPC ➔' : 'Manage IPC') + '</button></div></div>'
      );
      rows.push(
        '<tr class="hover:bg-slate-50 transition ' + (isCurrent ? 'bg-amber-50/40 font-medium' : '') + '">' +
        '<td class="py-3 px-3"><div class="flex items-center gap-1.5 mb-1"><span class="text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase ' + badge + '">' + esc(c.sector || 'General') + '</span></div>' +
        '<div class="font-bold text-slate-900">' + esc(c.companyName) + '</div><div class="text-slate-600 text-xs">' + esc(c.package) + '</div></td>' +
        '<td class="py-3 px-3 font-mono text-slate-600">' + esc(c.contractRef) + '</td>' +
        '<td class="py-3 px-3 text-right text-slate-700">' + formatSAR(num(c.originalContractSum)) + '</td>' +
        '<td class="py-3 px-3 text-right font-medium text-slate-900">' + formatSAR(f.revisedContractSum) + '</td>' +
        '<td class="py-3 px-3 text-right font-bold text-slate-800">' + formatSAR(f.grossCum) + '</td>' +
        '<td class="py-3 px-2 text-center"><span class="px-1.5 py-0.5 rounded text-[10px] font-bold ' + (f.progressPercent >= 50 ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-50 text-blue-700') + '">' + f.progressPercent.toFixed(1) + '%</span></td>' +
        '<td class="py-3 px-3 text-right text-rose-600">' + formatDeduction(f.retentionCum) + '</td>' +
        '<td class="py-3 px-3 text-right font-bold text-midad-gold bg-amber-50/60">' + formatSAR(f.finalDuePeriod) + '</td>' +
        '<td class="py-3 px-2 text-center"><span class="px-2 py-0.5 rounded text-[10px] font-bold ' + st.badge + '">' + esc(st.label) + '</span></td>' +
        '<td class="py-3 px-3 text-center no-print"><button data-action="open-ipc" data-id="' + esc(c.id) + '" class="text-xs px-2 py-1 rounded bg-slate-800 text-white hover:bg-slate-700 transition">Open IPC</button></td></tr>'
      );
    });
    $('contractorCardsContainer').innerHTML = cards.join('') ||
      '<div class="col-span-full text-center text-sm text-slate-400 py-8">No contractor packages in this sector.</div>';
    $('multiContractorTableBody').innerHTML = rows.join('') || emptyRow(10, 'No contractor packages in this sector.');

    setTxt('hubTotalCommitted', formatSAR(committed));
    setTxt('hubTotalCertified', formatSAR(certified));
    setTxt('hubTotalRetention', formatSAR(retention));
    setTxt('hubTotalCurrentDue', formatSAR(due));
    setTxt('hubContractorCount', proj.contractors.length + ' Packages Active');
    setTxt('hubOverallProgress', (committed > 0 ? (certified / committed * 100).toFixed(1) : '0.0') + '% Project Delivered');

    document.querySelectorAll('.trade-filter-btn').forEach(function (btn) {
      const on = btn.getAttribute('data-sector') === activeSectorFilter;
      btn.className = 'trade-filter-btn px-3 py-1.5 rounded-lg font-medium transition whitespace-nowrap ' +
        (on ? 'bg-slate-900 text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-slate-200');
    });
  }

  function renderCharts(proj, c, fin) {
    if (typeof window.Chart === 'undefined') {
      $('chartUnavailable').hidden = false;
      return;
    }
    $('chartUnavailable').hidden = true;

    const current = parseIpcNo(c.currentIpcNo);
    const planned = Math.max(1, monthsBetween(proj.commenceDate, proj.completeDate));
    const n = Math.max(planned, current);
    const labels = [];
    const plannedCurve = [];
    const actualCurve = [];
    let cum = 0;
    for (let k = 1; k <= n; k++) {
      labels.push(formatIpcNo(k) + (k === current ? ' (Now)' : ''));
      plannedCurve.push(+(fin.revisedContractSum * logisticShare(Math.min(1, k / planned)) / 1e6).toFixed(2));
      if (k < current && c.history[k - 1]) {
        cum += c.history[k - 1].gross;
        actualCurve.push(+(cum / 1e6).toFixed(2));
      } else if (k === current) {
        actualCurve.push(+(fin.grossCum / 1e6).toFixed(2));
      } else {
        actualCurve.push(null);
      }
    }

    if (scurveChart) scurveChart.destroy();
    scurveChart = new window.Chart($('scurveChart'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Planned baseline (indicative)', data: plannedCurve, borderColor: '#94a3b8', borderDash: [5, 5], tension: 0.35, fill: false, pointRadius: 0 },
          { label: 'Actual certified gross', data: actualCurve, borderColor: '#c5a059', backgroundColor: 'rgba(197,160,89,0.15)', borderWidth: 3, tension: 0.3, fill: true, pointRadius: 3, pointBackgroundColor: '#0f172a' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { label: function (ctx) { return ctx.dataset.label + ': SAR ' + ctx.parsed.y + 'M'; } } }
        },
        scales: { y: { title: { display: true, text: 'SAR (Millions)', font: { size: 10 } }, ticks: { callback: function (v) { return v + 'M'; } } } }
      }
    });

    const cfLabels = c.history.map(function (h) { return h.ipcNo; }).concat([c.currentIpcNo + ' (Now)']);
    const cfData = c.history.map(function (h) { return +(h.total / 1e6).toFixed(2); }).concat([+(fin.finalDuePeriod / 1e6).toFixed(2)]);
    const cfColors = c.history.map(function (h) { return h.status === 'Disbursed' ? '#0f172a' : '#3b82f6'; }).concat(['#c5a059']);
    if (cashflowChart) cashflowChart.destroy();
    cashflowChart = new window.Chart($('cashflowChart'), {
      type: 'bar',
      data: { labels: cfLabels, datasets: [{ label: 'Net certified incl. VAT (SAR M)', data: cfData, backgroundColor: cfColors, borderRadius: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (ctx) { return 'Net incl. VAT: SAR ' + ctx.parsed.y + 'M'; } } }
        },
        scales: { y: { title: { display: true, text: 'SAR (Millions)', font: { size: 10 } }, ticks: { callback: function (v) { return v + 'M'; } } } }
      }
    });
  }

  /* ================= Navigation ================= */

  function switchTab(tabId) {
    activeTab = tabId;
    document.querySelectorAll('.tab-content').forEach(function (el) { el.classList.add('hidden'); });
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      const on = btn.id === 'tab-' + tabId;
      btn.classList.toggle('border-midad-gold', on);
      btn.classList.toggle('text-midad-gold', on);
      btn.classList.toggle('border-transparent', !on);
      btn.classList.toggle('text-slate-400', !on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const el = $('content-' + tabId);
    if (el) el.classList.remove('hidden');
    if (tabId === 'analytics') {
      const c = activeContractor();
      if (c) renderCharts(activeProject(), c, calc(c));
    }
  }

  function switchProject(key) {
    if (!state.projects[key]) return;
    state.activeProjectKey = key;
    activeSectorFilter = 'all';
    commit();
    showToast('Switched project to: ' + activeProject().name, 'info');
  }

  function switchContractor(id) {
    const p = activeProject();
    if (!p.contractors.some(function (c) { return c.id === id; })) return;
    p.activeContractorId = id;
    commit();
  }

  /* ================= Modals ================= */

  function openModal(id) {
    const m = $(id);
    m.classList.remove('hidden');
    m.classList.add('flex');
    const first = m.querySelector('input, select, textarea');
    if (first) first.focus();
  }

  function closeModal(id) {
    const m = $(id);
    m.classList.add('hidden');
    m.classList.remove('flex');
  }

  /* ================= Actions ================= */

  function handleSaveContractor(e) {
    e.preventDefault();
    const proj = activeProject();
    const sum = num($('modalContractorSum').value);
    if (sum <= 0) return showToast('Contract value must be greater than zero.', 'warning');
    const trade = $('modalContractorTrade').value;
    const sectorMap = { 'Mixed-Use:': 'Mixed-Use', 'Plants:': 'Plants & Utilities', 'Hospitality:': 'Hospitality', 'Malls:': 'Malls & Retail', 'Residential:': 'Residential' };
    const prefix = Object.keys(sectorMap).find(function (k) { return trade.indexOf(k) === 0; });
    const pkg = $('modalContractorPackage').value.trim();
    const company = $('modalContractorCompany').value.trim();
    const today = todayDMY();

    const c = {
      id: 'c_' + Date.now(),
      companyName: company,
      package: pkg,
      sector: prefix ? sectorMap[prefix] : 'General',
      tradeCategory: trade,
      contractRef: $('modalContractorRef').value.trim(),
      repName: $('modalContractorRepName').value.trim(),
      repRole: $('modalContractorRepRole').value.trim() || 'Commercial Project Manager',
      originalContractSum: sum,
      advancePaymentOriginal: Math.max(0, optionalNumber('modalContractorAdv', sum * 0.10)),
      advanceRecoveryRate: Math.max(0, optionalNumber('modalContractorAdvRate', 10)) / 100,
      retentionRate: Math.max(0, optionalNumber('modalContractorRetRate', 10)) / 100,
      retentionCapRate: Math.max(0, optionalNumber('modalContractorRetCap', 5)) / 100,
      vatRate: 0.15,
      currentIpcNo: 'IPC-01',
      valuationPeriod: addMonths(today, -1).replace(/^\d+/, '01') + ' to ' + today,
      issueDate: today,
      approvalStatus: 'Under Review',
      otherDeductionsToDate: 0,
      otherDeductionsPrev: 0,
      boqItems: [
        { id: 1, code: '01.00', desc: 'Preliminaries, Site Engineering & Mobilization', unit: 'LS', rate: sum * 0.15, contractQty: 1, prevQty: 0, thisQty: 0 },
        { id: 2, code: '02.00', desc: 'Primary Scope Execution', unit: 'LS', rate: sum * 0.85, contractQty: 1, prevQty: 0, thisQty: 0 }
      ],
      variations: [],
      mos: [],
      history: [],
      audit: []
    };
    addAudit(c, 'blue', 'Contractor package enlisted', company + ' registered under ' + c.contractRef + '. Replace the placeholder BOQ with the priced bill.');
    proj.contractors.push(c);
    proj.activeContractorId = c.id;
    closeModal('contractorModal');
    e.target.reset();
    commit();
    switchTab('boq');
    showToast('Contractor package "' + company + '" registered. Placeholder BOQ created — replace it with the priced bill.', 'success');
  }

  function handleSaveBoqItem(e) {
    e.preventDefault();
    const c = activeContractor();
    if (!c) return;
    const code = $('modalBoqCode').value.trim();
    if (c.boqItems.some(function (i) { return String(i.code).toLowerCase() === code.toLowerCase(); })) {
      return showToast('BOQ item code "' + code + '" already exists for this package.', 'warning');
    }
    c.boqItems.push({
      id: nextId(c.boqItems),
      code: code,
      desc: $('modalBoqDesc').value.trim(),
      unit: $('modalBoqUnit').value.trim(),
      rate: num($('modalBoqRate').value),
      contractQty: num($('modalBoqContractQty').value),
      prevQty: Math.max(0, num($('modalBoqPrevQty').value)),
      thisQty: num($('modalBoqThisQty').value)
    });
    addAudit(c, 'blue', 'BOQ item added: ' + code, $('modalBoqDesc').value.trim());
    closeModal('boqModal');
    e.target.reset();
    commit();
    showToast('Added BOQ item ' + code, 'success');
  }

  function handleSaveVo(e) {
    e.preventDefault();
    const c = activeContractor();
    if (!c) return;
    const code = $('modalVoCode').value.trim();
    if (c.variations.some(function (v) { return String(v.code).toLowerCase() === code.toLowerCase(); })) {
      return showToast('Variation "' + code + '" already exists for this package.', 'warning');
    }
    const status = $('modalVoStatus').value;
    c.variations.push({
      id: nextId(c.variations),
      code: code,
      desc: $('modalVoDesc').value.trim(),
      date: todayDMY(),
      approvedSum: num($('modalVoAmount').value),
      prevPct: 0,
      progressPct: Math.min(100, Math.max(0, num($('modalVoPct').value))),
      status: status
    });
    addAudit(c, 'amber', 'Variation ' + code + ' registered (' + status + ')', $('modalVoDesc').value.trim());
    closeModal('voModal');
    e.target.reset();
    commit();
    showToast('Variation ' + code + ' registered as ' + status, 'success');
  }

  function handleSaveMos(e) {
    e.preventDefault();
    const c = activeContractor();
    if (!c) return;
    const code = $('modalMosCode').value.trim();
    c.mos.push({
      id: nextId(c.mos),
      code: code,
      desc: $('modalMosDesc').value.trim(),
      unit: $('modalMosUnit').value.trim(),
      prevQty: 0,
      qty: Math.max(0, num($('modalMosQty').value)),
      invoiceRate: num($('modalMosRate').value),
      certPct: Math.min(100, Math.max(0, optionalNumber('modalMosPct', 75)))
    });
    addAudit(c, 'blue', 'MOS consignment ' + code + ' registered', $('modalMosDesc').value.trim());
    closeModal('mosModal');
    e.target.reset();
    commit();
    showToast('Materials on site ' + code + ' registered', 'success');
  }

  function findById(list, id) {
    return list.find(function (x) { return String(x.id) === String(id); });
  }

  function onBoqQty(id, value) {
    const c = activeContractor();
    const item = c && findById(c.boqItems, id);
    if (!item) return;
    // Negative period quantities are allowed (remeasurement corrections) but cumulative can't go below zero.
    const q = num(value);
    item.thisQty = Math.max(-num(item.prevQty), q);
    commit();
    if (item.thisQty !== q) showToast('Quantity limited so cumulative is not below zero.', 'warning');
  }

  function onVoPct(id, value) {
    const c = activeContractor();
    const vo = c && findById(c.variations, id);
    if (!vo) return;
    vo.progressPct = Math.min(100, Math.max(0, num(value)));
    commit();
  }

  function onMosQty(id, value) {
    const c = activeContractor();
    const m = c && findById(c.mos, id);
    if (!m) return;
    m.qty = Math.max(0, num(value));
    commit();
  }

  function onOtherDeduction(value) {
    const c = activeContractor();
    if (!c) return;
    c.otherDeductionsToDate = num(c.otherDeductionsPrev) + num(value);
    addAudit(c, 'red', 'Other deductions this period set to ' + formatSAR(num(value)), 'NCR withholding / safety penalty adjustment for ' + c.currentIpcNo + '.');
    commit();
  }

  function deleteFrom(listName, id, label) {
    const c = activeContractor();
    const item = c && findById(c[listName], id);
    if (!item) return;
    if (!window.confirm('Delete ' + label + ' ' + item.code + '? This cannot be undone.')) return;
    c[listName] = c[listName].filter(function (x) { return String(x.id) !== String(id); });
    addAudit(c, 'red', label + ' ' + item.code + ' deleted', item.desc || '');
    commit();
    showToast(label + ' ' + item.code + ' removed', 'warning');
  }

  function toggleVoStatus(id) {
    const c = activeContractor();
    const vo = c && findById(c.variations, id);
    if (!vo) return;
    vo.status = vo.status === 'Approved' ? 'Pending' : 'Approved';
    addAudit(c, 'amber', 'Variation ' + vo.code + ' set to ' + vo.status, vo.status === 'Approved' ? 'Now included in revised contract sum and valuation.' : 'Excluded from valuation until approved.');
    commit();
  }

  function markHistoryPaid(idx) {
    const c = activeContractor();
    const h = c && c.history[idx];
    if (!h) return;
    h.status = 'Disbursed';
    addAudit(c, 'green', h.ipcNo + ' payment disbursed', formatSAR(h.total) + ' released by Treasury.');
    commit();
  }

  function newIpcCycle() {
    const c = activeContractor();
    if (!c) return;
    if (c.approvalStatus !== 'Approved') {
      showToast(c.currentIpcNo + ' must be approved before opening the next cycle (Verification & Approvals tab).', 'warning');
      switchTab('workflow');
      return;
    }
    const fin = calc(c);
    const nextNo = formatIpcNo(parseIpcNo(c.currentIpcNo) + 1);
    if (!window.confirm('Close ' + c.currentIpcNo + ' (net due ' + formatSAR(fin.finalDuePeriod) + ') and open ' + nextNo + '? Current quantities will be locked as "previous".')) return;

    c.history.push({
      ipcNo: c.currentIpcNo,
      period: shortMonth(String(c.valuationPeriod).split(' to ')[0]),
      gross: fin.grossPeriod,
      retention: fin.retentionPeriod,
      advance: fin.advRecoveredPeriod,
      other: fin.otherDeductionsPeriod,
      net: fin.netPeriod,
      vat: fin.vatPeriod,
      total: fin.finalDuePeriod,
      status: 'Certified'
    });
    c.boqItems.forEach(function (i) { i.prevQty = num(i.prevQty) + num(i.thisQty); i.thisQty = 0; });
    c.variations.forEach(function (v) { v.prevPct = num(v.progressPct); });
    c.mos.forEach(function (m) { m.prevQty = num(m.qty); });
    c.otherDeductionsPrev = num(c.otherDeductionsToDate);

    const parts = String(c.valuationPeriod).split(' to ');
    c.valuationPeriod = addMonths(parts[0], 1) + ' to ' + addMonths(parts[1] || parts[0], 1);
    c.issueDate = addMonths(c.issueDate, 1);
    c.currentIpcNo = nextNo;
    c.approvalStatus = 'Under Review';
    addAudit(c, 'gold', 'New valuation cycle opened: ' + nextNo, 'Previous cumulative quantities locked for ' + c.package + '. Ready for new measurements.');
    commit();
    switchTab('boq');
    showToast('Opened ' + nextNo + ' for ' + c.companyName, 'success');
  }

  function updateApprovalStatus(status) {
    const c = activeContractor();
    if (!c) return;
    if (status === 'Returned') {
      const reason = window.prompt('Reason for returning ' + c.currentIpcNo + ' to the contractor:', 'Measurement clarification required');
      if (reason === null) return;
      c.approvalStatus = 'Returned';
      addAudit(c, 'red', c.currentIpcNo + ' returned with snags', reason || 'No reason given.');
      commit();
      showToast(c.currentIpcNo + ' returned to ' + c.companyName, 'warning');
      return;
    }
    c.approvalStatus = 'Approved';
    addAudit(c, 'green', 'Final commercial approval granted for ' + c.currentIpcNo,
      'Approved by ' + state.approver.name + '. Net payable ' + formatSAR(calc(c).finalDuePeriod) + ' transmitted to Finance & Treasury.');
    commit();
    showToast(c.currentIpcNo + ' approved for ' + c.companyName, 'success');
  }

  function resetDemo() {
    if (!window.confirm('Reset ALL projects, contractors and IPC history to the demo data? Your local changes will be lost (export first if needed).')) return;
    state = freshState();
    activeSectorFilter = 'all';
    commit();
    showToast('Demo data restored', 'info');
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ascto-ipc-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importData(file) {
    if (!file) return;
    file.text().then(function (txt) {
      const s = JSON.parse(txt);
      if (!isValidState(s)) throw new Error('missing projects');
      Object.values(s.projects).forEach(function (p) { (p.contractors = p.contractors || []).forEach(normalizeContractor); });
      if (!s.projects[s.activeProjectKey]) s.activeProjectKey = Object.keys(s.projects)[0];
      if (!s.approver) s.approver = window.IPC_SEED.approver;
      state = s;
      commit();
      showToast('Backup imported', 'success');
    }).catch(function () {
      showToast('Import failed: not a valid ASCTO IPC backup file.', 'warning');
    });
  }

  function filterBoqTable() {
    const q = ($('boqSearch').value || '').toLowerCase();
    document.querySelectorAll('#boqTableBody tr').forEach(function (r) {
      r.style.display = r.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
    });
  }

  function printCertificate() {
    switchTab('certificate');
    window.print();
  }

  function showToast(message, type) {
    const container = $('toastContainer');
    const t = type || 'info';
    const toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.className = 'px-4 py-3 rounded-lg shadow-lg border text-xs font-semibold flex items-center gap-2 transition-all duration-300 translate-y-2 opacity-0 pointer-events-auto max-w-sm ' +
      (t === 'success' ? 'bg-emerald-900 text-white border-emerald-700' : t === 'warning' ? 'bg-amber-900 text-white border-amber-700' : 'bg-slate-900 text-white border-slate-700');
    const icon = document.createElement('span');
    icon.className = 'font-bold text-sm';
    icon.textContent = t === 'success' ? '✓' : t === 'warning' ? '⚠' : 'ℹ';
    const text = document.createElement('span');
    text.textContent = message;
    toast.append(icon, text);
    container.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.remove('translate-y-2', 'opacity-0'); });
    setTimeout(function () {
      toast.classList.add('opacity-0', 'translate-y-2');
      setTimeout(function () { toast.remove(); }, 300);
    }, 4000);
  }

  /* ================= Wiring ================= */

  function bindEvents() {
    $('projectSelector').addEventListener('change', function (e) { switchProject(e.target.value); });
    $('contractorSelector').addEventListener('change', function (e) {
      switchContractor(e.target.value);
      const c = activeContractor();
      showToast('Active contractor: ' + c.companyName, 'info');
    });
    document.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.id.replace('tab-', '')); });
    });
    document.querySelectorAll('.trade-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeSectorFilter = btn.getAttribute('data-sector');
        renderContractorsTab();
      });
    });

    const clicks = {
      btnAddContractor: function () { openModal('contractorModal'); },
      btnAddContractorHub: function () { openModal('contractorModal'); },
      btnPrint: printCertificate,
      btnNewIpc: newIpcCycle,
      btnAddBoq: function () { openModal('boqModal'); },
      btnAddVo: function () { openModal('voModal'); },
      btnAddMos: function () { openModal('mosModal'); },
      btnResetDemo: resetDemo,
      btnExport: exportData,
      btnImport: function () { $('importFile').click(); },
      btnApprove: function () { updateApprovalStatus('Approved'); },
      btnReturn: function () { updateApprovalStatus('Returned'); }
    };
    Object.keys(clicks).forEach(function (id) { $(id).addEventListener('click', clicks[id]); });

    $('importFile').addEventListener('change', function (e) {
      importData(e.target.files[0]);
      e.target.value = '';
    });
    $('boqSearch').addEventListener('input', filterBoqTable);
    $('othPeriodInput').addEventListener('change', function (e) { onOtherDeduction(e.target.value); });

    $('contractorForm').addEventListener('submit', handleSaveContractor);
    $('boqForm').addEventListener('submit', handleSaveBoqItem);
    $('voForm').addEventListener('submit', handleSaveVo);
    $('mosForm').addEventListener('submit', handleSaveMos);

    // Delegated handlers for dynamically rendered rows.
    document.addEventListener('change', function (e) {
      const a = e.target.getAttribute && e.target.getAttribute('data-action');
      const id = e.target.getAttribute && e.target.getAttribute('data-id');
      if (a === 'boq-qty') onBoqQty(id, e.target.value);
      else if (a === 'vo-pct') onVoPct(id, e.target.value);
      else if (a === 'mos-qty') onMosQty(id, e.target.value);
    });
    document.addEventListener('click', function (e) {
      const el = e.target.closest && e.target.closest('[data-action]');
      if (!el) {
        if (e.target.classList && e.target.classList.contains('modal-backdrop')) closeModal(e.target.id);
        return;
      }
      const a = el.getAttribute('data-action');
      const id = el.getAttribute('data-id');
      if (a === 'boq-del') deleteFrom('boqItems', id, 'BOQ item');
      else if (a === 'vo-del') deleteFrom('variations', id, 'Variation');
      else if (a === 'mos-del') deleteFrom('mos', id, 'MOS consignment');
      else if (a === 'vo-status') toggleVoStatus(id);
      else if (a === 'hist-paid') markHistoryPaid(parseInt(el.getAttribute('data-idx'), 10));
      else if (a === 'open-ipc') { switchContractor(id); switchTab('certificate'); }
      else if (a === 'close-modal') closeModal(el.getAttribute('data-target'));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.modal-backdrop').forEach(function (m) { if (!m.classList.contains('hidden')) closeModal(m.id); });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    state = loadState();
    bindEvents();
    saveState();
    renderApp();
    switchTab('contractors');
  });
})();
