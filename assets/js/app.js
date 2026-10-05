/*
 * ASCTO IPC — application controller (state, persistence, rendering, actions).
 * Depends on: calc.js (window.IPC), certificate.js (window.IPCCert), export-xlsx.js (window.IPCExport),
 * data.js (window.IPC_SEED), templates/ipc-template.js, Chart.js 4.x (window.Chart, optional).
 */
(function () {
  'use strict';

  const {
    num, formatSAR, formatNumber, formatIpcNo, parseIpcNo, parseDMY, formatDMY,
    addMonths, monthsBetween, shortMonth, calculateContractorFinancials: calc, logisticShare
  } = window.IPC;
  const { buildCertificate, defaultSettings, CONSULTANT_POSITIONS } = window.IPCCert;

  const STORAGE_KEY = 'ascto-ipc-state-v1';
  const SECTOR_COLORS = {
    'Mixed-Use': 'bg-indigo-100 text-indigo-800 border-indigo-200',
    'Plants & Utilities': 'bg-teal-100 text-teal-800 border-teal-200',
    'Hospitality': 'bg-purple-100 text-purple-800 border-purple-200',
    'Malls & Retail': 'bg-pink-100 text-pink-800 border-pink-200',
    'Residential': 'bg-emerald-100 text-emerald-800 border-emerald-200'
  };
  const STATUS_BADGE = {
    'Under Review': 'bg-amber-100 text-amber-800',
    'Approved': 'bg-emerald-100 text-emerald-800',
    'Returned': 'bg-rose-100 text-rose-800'
  };
  const STAGES = [
    { key: 'consultant', label: 'Consultant Valuation', who: 'Consultant site office' },
    { key: 'siteOffice', label: 'Site Office Review', who: 'Employer site office' },
    { key: 'homeOffice', label: 'Home Office Approval', who: 'Employer home office' }
  ];
  // Template lines entered as "this period" movements on top of a stored previous cumulative.
  const ADJUSTMENTS = [
    { key: 'reimbursables', line: '02', label: 'Reimbursable expenses, equipment, transport', kind: 'add' },
    { key: 'retentionReleased', line: '05', label: 'Release of retention', kind: 'add' },
    { key: 'vatAdjustment', line: '06', label: 'VAT adjustment value (not re-taxed)', kind: 'add' },
    { key: 'liquidatedDamages', line: '08', label: 'Liquidated damages', kind: 'ded' },
    { key: 'otherDeductions', line: '09', label: 'Other deductions (NCR / safety penalties)', kind: 'ded' },
    { key: 'otherPayments', line: '11', label: 'Other payments made outside IPCs', kind: 'ded' }
  ];
  const DETAIL_FIELDS = [
    ['companyName', 'Contractor name', 'text', true],
    ['package', 'Contract name / scope', 'text', true],
    ['contractRef', 'Contract number', 'text', true],
    ['contractType', 'Contract type', 'text'],
    ['paymentType', 'Payment type', 'text'],
    ['taxInvoiceNo', 'Tax invoice no.', 'text'],
    ['invoiceDate', 'Invoice date', 'date'],
    ['valuationDate', 'Date of valuation', 'date'],
    ['repName', 'Contractor representative', 'text'],
    ['repRole', 'Representative title', 'text'],
    ['beneficiaryName', 'Beneficiary name', 'text'],
    ['vatRegNo', 'Contractor VAT reg. number', 'text'],
    ['bankName', 'Bank name', 'text'],
    ['iban', 'IBAN no.', 'text'],
    ['advanceValidUntil', 'Advance payment guarantee valid until', 'date'],
    ['performanceBondValue', 'Performance bond value (SAR)', 'number'],
    ['performanceBondValidUntil', 'Performance bond valid until', 'date'],
    ['piInsuranceValue', 'P.I. insurance value (SAR)', 'number'],
    ['tplInsuranceValue', 'Third party liability value (SAR)', 'number'],
    ['wcInsuranceValue', "Workmen's compensation value (SAR)", 'number']
  ];
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
    return formatDMY({ d: d.getDate(), m: d.getMonth(), y: d.getFullYear() });
  }

  function nowStamp() {
    const d = new Date();
    return todayDMY() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function dmyToIso(s) {
    const p = parseDMY(s);
    return p ? p.y + '-' + String(p.m + 1).padStart(2, '0') + '-' + String(p.d).padStart(2, '0') : '';
  }

  function isoToDmy(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? formatDMY({ d: parseInt(m[3], 10), m: parseInt(m[2], 10) - 1, y: parseInt(m[1], 10) }) : '';
  }

  // Reads an optional numeric form field: blank -> fallback, otherwise the number (0 is a valid entry).
  function optionalNumber(id, fallback) {
    const raw = ($(id).value || '').trim();
    if (raw === '') return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function periodEnd(c) {
    const parts = String(c.valuationPeriod || '').split(' to ');
    return parts[1] || parts[0] || '';
  }

  /* ================= Status & sign-off ================= */

  function nextStage(c) {
    if (c.returned) return null;
    const s = STAGES.find(function (st) { return !c.signoffs[st.key]; });
    return s || null;
  }

  function syncStatus(c) {
    c.approvalStatus = c.returned ? 'Returned' : c.signoffs.homeOffice ? 'Approved' : 'Under Review';
  }

  function statusLabel(c) {
    if (c.returned) return 'Returned with Snags';
    const n = nextStage(c);
    return n ? 'Awaiting ' + n.label : 'Approved';
  }

  // Any change to the valuation after someone has signed invalidates the signatures:
  // nobody should be able to approve one figure and pay another.
  function valuationChanged(c, what) {
    if (!STAGES.some(function (st) { return c.signoffs[st.key]; })) return;
    c.signoffs = { consultant: null, siteOffice: null, homeOffice: null };
    syncStatus(c);
    addAudit(c, 'red', 'Sign-offs cleared', what + ' changed after sign-off — the certificate must be re-certified.');
    showToast('Valuation changed after sign-off — sign-offs cleared, re-certification required.', 'warning');
  }

  /* ================= State & persistence ================= */

  function historyRow(ipcNo, period, f) {
    return {
      ipcNo: ipcNo, period: period,
      gross: f.gross, retention: f.retention, advance: f.advance, other: f.other,
      net: f.net, vat: f.vat, postVat: f.postVat || 0, total: f.total, status: f.status || 'Disbursed'
    };
  }

  function seedHistory(c) {
    const fin = calc(c);
    const prior = parseIpcNo(c.currentIpcNo) - 1;
    const periodStart = String(c.valuationPeriod || '').split(' to ')[0];
    c.history = [];
    if (prior < 0) return;

    // IPC-00: the advance payment certificate (template line 04), paid before the first valuation.
    if (fin.advPaid.prev > 0) {
      const adv = fin.advPaid.prev;
      c.history.push(historyRow('IPC-00', shortMonth(addMonths(periodStart, -prior - 1)), {
        gross: adv, retention: 0, advance: 0, other: 0, net: adv, vat: adv * fin.vatRate, total: adv * (1 + fin.vatRate)
      }));
    }
    if (prior === 0 || fin.grossPrev <= 0) return;

    // Split the previously certified work value across prior IPCs along an S-shaped profile.
    // The final prior row lands exactly on the "Last Period" figures, so the ledger reconciles.
    const worksShare = (fin.boqPrevTotal + fin.voPrevTotal) / fin.grossPrev;
    let last = { gross: 0, ret: 0, adv: 0, oth: 0 };
    for (let k = 1; k <= prior; k++) {
      const share = k === prior ? 1 : 0.5 * (k / prior) + 0.5 * logisticShare(k / prior);
      const gross = fin.grossPrev * share;
      const cum = {
        gross: gross,
        ret: Math.min(gross * worksShare * fin.retentionRate, fin.retentionCap),
        adv: Math.min(gross * fin.advRecoveryRate, fin.advPaid.prev),
        oth: k === prior ? fin.otherDeductionsPrev : 0
      };
      const r = { gross: cum.gross - last.gross, retention: cum.ret - last.ret, advance: cum.adv - last.adv, other: cum.oth - last.oth };
      r.net = r.gross - r.retention - r.advance - r.other;
      r.vat = r.net * fin.vatRate;
      r.total = r.net + r.vat;
      c.history.push(historyRow(formatIpcNo(k), shortMonth(addMonths(periodStart, k - prior - 1)), r));
      last = cum;
    }
  }

  function normalizeContractor(c) {
    c.boqItems = c.boqItems || [];
    c.variations = c.variations || [];
    c.mos = c.mos || [];
    c.variations.forEach(function (v) { if (v.prevPct == null) v.prevPct = 0; });
    c.mos.forEach(function (m) { if (m.prevQty == null) m.prevQty = 0; });
    ADJUSTMENTS.forEach(function (a) {
      if (c[a.key + 'ToDate'] == null) c[a.key + 'ToDate'] = 0;
      if (c[a.key + 'Prev'] == null) c[a.key + 'Prev'] = 0;
    });
    if (c.advancePaidToDate == null) c.advancePaidToDate = num(c.advancePaymentOriginal);
    if (c.advancePaidPrev == null) c.advancePaidPrev = num(c.advancePaymentOriginal);
    if (c.postVatDeduction == null) c.postVatDeduction = 0;
    if (!c.paymentType) c.paymentType = 'Interim Payment';
    if (!c.contractType) c.contractType = 'Re-measured (FIDIC Red Book)';
    if (c.invoiceDate == null) c.invoiceDate = c.issueDate || '';
    if (c.valuationDate == null) c.valuationDate = periodEnd(c);
    ['taxInvoiceNo', 'beneficiaryName', 'vatRegNo', 'bankName', 'iban', 'advanceValidUntil', 'performanceBondValidUntil'].forEach(function (k) {
      if (c[k] == null) c[k] = '';
    });
    ['performanceBondValue', 'piInsuranceValue', 'tplInsuranceValue', 'wcInsuranceValue'].forEach(function (k) {
      if (c[k] == null) c[k] = 0;
    });

    if (!c.signoffs) {
      // Map the earlier single-step status onto the template's three sign-off tiers.
      const d = c.issueDate || todayDMY();
      const st = c.approvalStatus === 'Flagged' ? 'Returned' : c.approvalStatus;
      c.signoffs = { consultant: st === 'Returned' ? null : d, siteOffice: st === 'Approved' ? d : null, homeOffice: st === 'Approved' ? d : null };
      c.returned = st === 'Returned' ? { reason: 'Returned for clarification', ts: d } : null;
    }
    if (c.returned === undefined) c.returned = null;
    syncStatus(c);

    if (!Array.isArray(c.history)) seedHistory(c);
    if (!Array.isArray(c.audit)) {
      c.audit = [{ ts: c.issueDate, tone: 'blue', title: c.currentIpcNo + ' payment application submitted', detail: 'Submitted by ' + c.companyName + ' with joint measurements.' }];
      STAGES.forEach(function (st) {
        if (c.signoffs[st.key]) c.audit.unshift({ ts: c.signoffs[st.key], tone: 'green', title: st.label + ' signed', detail: st.who + ' signed ' + c.currentIpcNo + '.' });
      });
    }
  }

  /* ----- Link to the Crystal Gallery cost model (window.CG_COSTING, generated by tools/sync_costing.py) ----- */

  function isoToDMYUTC(iso, addDays) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + (addDays || 0));
    return formatDMY({ d: d.getUTCDate(), m: d.getUTCMonth(), y: d.getUTCFullYear() });
  }

  // Contract quantities, rates, the contract sum and programme dates always come from the cost model.
  // Only measurement (last/this period quantities) and certificate data belong to the IPC app.
  function syncCosting(p) {
    const cg = window.CG_COSTING;
    if (!cg) return;
    const linked = p.contractors.filter(function (c) { return c.linkedCosting; });
    if (!linked.length) return;
    p.commenceDate = isoToDMYUTC(cg.constructionStart, 0);
    p.completeDate = isoToDMYUTC(cg.constructionStart, cg.durationDays);
    linked.forEach(function (c) {
      const prevSum = c.originalContractSum;
      const existing = {};
      c.boqItems.forEach(function (i) { existing[i.code] = i; });
      let id = nextId(c.boqItems);
      const items = cg.lines.map(function (l) {
        const old = existing[l.code];
        delete existing[l.code];
        return {
          id: old ? old.id : id++, code: l.code, desc: l.desc, unit: l.unit,
          rate: l.amt / l.qty, contractQty: l.qty,
          prevQty: old ? num(old.prevQty) : 0, thisQty: old ? num(old.thisQty) : 0,
          linked: true, src: l.src, source: l.source
        };
      });
      // A line dropped from the cost model keeps any measured work, flagged for the QS; unmeasured ones go.
      Object.values(existing).forEach(function (old) {
        if (!old.linked) items.push(old);
        else if (num(old.prevQty) || num(old.thisQty)) items.push(Object.assign({}, old, { linked: false, removedFromCostPlan: true }));
      });
      c.boqItems = items;
      c.originalContractSum = cg.totals.outturn;
      c.costingLink = { commit: cg.source.commit, ref: cg.source.ref, outturn: cg.totals.outturn, reserve: cg.totals.contingency, contingencyPct: cg.contingencyPct };
      // The advance is a % of the contract sum until it has been paid (IPC-00 not yet approved).
      if (c.advanceRate != null && parseIpcNo(c.currentIpcNo) === 0 && !(c.signoffs && c.signoffs.homeOffice)) {
        c.advancePaymentOriginal = Math.round(cg.totals.outturn * c.advanceRate * 100) / 100;
        c.advancePaidToDate = c.advancePaymentOriginal;
      }
      if (prevSum != null && Math.abs(prevSum - cg.totals.outturn) > 0.5 && Array.isArray(c.audit)) {
        addAudit(c, 'amber', 'Contract sum updated from the cost model',
          formatSAR(prevSum) + ' → ' + formatSAR(cg.totals.outturn) + ' (cost model ' + String(cg.source.commit || '').slice(0, 7) + ').');
        valuationChanged(c, 'Contract sum (cost model)');
      }
    });
  }

  function normalizeProject(p) {
    p.contractors = p.contractors || [];
    if (!Array.isArray(p.consultantTeam)) {
      // Template order: Sr. Engineer, Quantity Surveyor, Contracts Administrator, Project Manager.
      p.consultantTeam = ['', '', '', p.engineerName || ''];
    }
    p.contractors.forEach(normalizeContractor);
    syncCosting(p);
  }

  // Seed project names retired in later releases: saved data is renamed once and opened on that project.
  const RENAMED_PROJECTS = { p4: { from: 'ASCTO Riyadh Avenue Mega Mall & FEC - Riyadh', to: 'Crystal Gallery Mall' } };

  function normalizeState(s) {
    s.version = 2;
    const seedP4 = window.IPC_SEED.projects.p4;
    if (s.projects.p4 && !s.projects.p4.contractors.some(function (c) { return c.linkedCosting; })) {
      s.projects.p4 = JSON.parse(JSON.stringify(seedP4));
      s.activeProjectKey = 'p4';
    }
    Object.keys(RENAMED_PROJECTS).forEach(function (key) {
      const r = RENAMED_PROJECTS[key];
      if (s.projects[key] && s.projects[key].name === r.from) {
        s.projects[key].name = r.to;
        s.activeProjectKey = key;
      }
    });
    const d = defaultSettings();
    s.settings = s.settings || {};
    s.settings.employerName = s.settings.employerName || d.employerName;
    s.settings.siteOffice = s.settings.siteOffice || d.siteOffice;
    s.settings.homeOffice = s.settings.homeOffice || d.homeOffice;
    delete s.approver;
    Object.values(s.projects).forEach(normalizeProject);
    if (!s.projects[s.activeProjectKey]) s.activeProjectKey = Object.keys(s.projects)[0];
    return s;
  }

  function freshState() {
    const seed = JSON.parse(JSON.stringify(window.IPC_SEED));
    const first = seed.projects[seed.defaultProject] ? seed.defaultProject : Object.keys(seed.projects)[0];
    return normalizeState({ projects: seed.projects, activeProjectKey: first });
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
    return isValidState(saved) ? normalizeState(saved) : freshState();
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
    $('projectSelector').innerHTML = Object.values(state.projects).map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (p.id === state.activeProjectKey ? ' selected' : '') + '>' +
        esc(p.name) + ' (' + esc(p.sector) + ')</option>';
    }).join('');
    const p = activeProject();
    $('contractorSelector').innerHTML = p.contractors.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === p.activeContractorId ? ' selected' : '') + '>' +
        esc(c.companyName) + ' (' + esc(c.package) + ')</option>';
    }).join('');
  }

  function renderApp() {
    renderSelectors();
    const proj = activeProject();
    const c = activeContractor();
    renderContractorsTab();
    $('noContractorNotice').hidden = !!c;
    if (!c) return;
    const fin = calc(c);

    renderKpis(c, fin);
    renderCertificate(proj, c, fin);
    renderCostingBanner(c);
    renderBoqTable(c, fin);
    renderVoTable(c);
    renderMosTable(c, fin);
    renderDeductions(c, fin);
    renderWorkflow(proj, c);
    renderAnalyticsSummary(fin);
    if (activeTab === 'analytics') renderCharts(proj, c, fin);
  }

  function renderKpis(c, fin) {
    setTxt('kpiRevisedContract', formatSAR(fin.revisedContractSum));
    setTxt('kpiOriginalContract', 'Base: ' + formatSAR(c.originalContractSum));
    setTxt('kpiGrossCertified', formatSAR(fin.grossCum));
    setTxt('kpiPercentCompleted', fin.progressPercent.toFixed(2) + '%');
    setTxt('kpiNetPayable', formatSAR(fin.netPaymentDue));
    setTxt('kpiVatAmount', (fin.vatRate * 100).toFixed(0) + '% VAT: ' + formatSAR(fin.vatPeriod));
    setTxt('kpiIpcNumber', c.currentIpcNo);
    const badge = $('kpiStatusBadge');
    badge.textContent = statusLabel(c);
    badge.className = 'text-xs px-2 py-0.5 rounded-full font-medium ' + STATUS_BADGE[c.approvalStatus];
    setTxt('kpiValuationDate', 'Cut-off: ' + periodEnd(c));
  }

  /* ----- Certificate: on-screen replica of the official template (A1:M62) ----- */

  // Template column widths A..M (Excel character units, K/L widened — see tools/clean_template.py).
  const CERT_COLS = [9.4, 5.9, 3.1, 6.4, 9.7, 21, 3.6, 4.6, 17, 31.4, 18, 18, 31.3];

  function amt(n, red) {
    if (n == null) return '';
    const v = round2(n);
    const s = formatNumber(Math.abs(v));
    if (v < 0) return '<span class="text-rose-600">(' + s + ')</span>';
    return red ? '<span class="text-rose-600">' + s + '</span>' : s;
  }

  function cell(html, span, cls, rowspan) {
    return '<td' + (span > 1 ? ' colspan="' + span + '"' : '') + (rowspan > 1 ? ' rowspan="' + rowspan + '"' : '') +
      ' class="' + (cls || '') + '">' + (html == null ? '' : html) + '</td>';
  }

  function kv(label, value, label2, value2, valueCls) {
    return '<tr>' + cell(esc(label), 5, 'cl') + cell(value, 5, 'cv ' + (valueCls || '')) + cell(esc(label2 || ''), 1, 'cl') + cell(value2, 2, 'cv') + '</tr>';
  }

  function band(text, cls) {
    return '<tr>' + cell(esc(text), 13, 'cband ' + (cls || '')) + '</tr>';
  }

  function renderCertificate(proj, c, fin) {
    const m = buildCertificate(state.settings, proj, c, fin);
    const a = m.application;
    const k = m.contract;
    const naAmount = function (n) { return n > 0 ? formatNumber(n) : 'N/A'; };
    const rows = [];

    rows.push('<tr class="crow-logo">' + cell(esc(m.header.employer), 3, 'clogo') + cell(esc(m.header.consultant), 9, 'clogo') + cell(esc(m.header.contractor), 1, 'clogo') + '</tr>');
    rows.push(band('CONTRACTOR PAYMENT CERTIFICATE', 'ctitle'));
    rows.push(band('PAYMENT APPLICATION DETAILS', 'csection'));
    rows.push(kv('Payment Application No.:', '<b>' + esc(a.ipcNo) + '</b>', 'Payment Type:', esc(a.paymentType)));
    rows.push(kv('TAX Invoice No.:', esc(a.taxInvoiceNo), 'Invoice Date:', esc(a.invoiceDate)));
    rows.push(kv('Period of Valuation:', esc(a.periodOfValuation) + ' <span class="text-slate-500 font-normal">(' + esc(a.periodRange) + ')</span>', 'Date of Valuation:', esc(a.valuationDate)));
    rows.push(band('PROJECT/CONTRACT DETAILS', 'csection'));
    rows.push(kv('Contractor Name:', '<b>' + esc(k.contractorName) + '</b>', 'Contract Number:', esc(k.contractNumber)));
    rows.push(kv('Contract Name/Scope:', esc(k.scope), 'Contract Type:', esc(k.contractType)));
    rows.push(kv('Original Contract Sum:', formatNumber(k.originalSum), 'Commencement Date:', esc(k.commencement)));
    rows.push(kv('Approved Variation Orders:', formatNumber(k.approvedVOs), 'Original Completion Date:', esc(k.completion)));
    rows.push(kv('Revised Contract Sum:', '<b>' + formatNumber(k.revisedSum) + '</b>', 'Duration', esc(k.duration)));
    rows.push(kv('Remaining Contract Sum', formatNumber(k.remainingSum), 'Beneficiary Name', esc(k.beneficiary)));
    rows.push(kv('Contractor`s VAT Reg. Number:', esc(k.vatRegNo), 'Bank Name', esc(k.bankName)));
    rows.push(kv('', '', 'IBAN No.', esc(k.iban)));
    [['Advance Payment Value:', k.advanceValue, k.advanceValidUntil], ['Performance Bond Value:', k.bondValue, k.bondValidUntil]].forEach(function (r) {
      rows.push('<tr>' + cell(esc(r[0]), 5, 'cl') + cell(naAmount(r[1]), 1, 'cv') + cell('Valid until', 3, 'cl') + cell(esc(r[2] || 'N/A'), 1, 'cv') + cell('', 3, 'cv') + '</tr>');
    });
    [['P.I Insurance Value:', k.piInsurance], ['Third Party Liability Value:', k.tplInsurance], ["Workmen's Compensation Value:", k.wcInsurance]].forEach(function (r) {
      rows.push('<tr>' + cell(esc(r[0]), 5, 'cl') + cell(naAmount(r[1]), 5, 'cv') + cell('', 3, 'cv') + '</tr>');
    });

    rows.push(band('PAYMENT DETAILS', 'csection'));
    rows.push('<tr class="chead">' + cell('', 9) + cell('LAST PERIOD', 1, 'text-center') + cell('THIS PERIOD', 1, 'text-center') + cell('CUMULATIVE', 1, 'text-center') + cell('Remarks', 1, 'text-center') + '</tr>');
    const groups = { 23: ['CURRENT VALUATION OF WORKS DONE', 9], 32: ['DEDUCTIONS', 5], 37: ['NET PAYMENTS TO DATE', 3], 40: ['', 1] };
    m.lines.forEach(function (l) {
      const isTotal = l.style.indexOf('total') >= 0;
      const red = l.style.indexOf('ded') >= 0;
      const cls = isTotal ? 'ctotal' : '';
      let html = '<tr class="' + cls + '">';
      if (groups[l.row]) html += cell(esc(groups[l.row][0]), 1, 'cgroup', groups[l.row][1]);
      const descCls = l.style === 'head' ? 'font-bold' : l.style === 'sub' ? 'pl-6' : l.style === 'vat' ? 'font-bold text-emerald-700' : l.style === 'vatadj' ? 'font-bold text-orange-600' : red && !isTotal ? 'font-bold text-rose-600' : '';
      html += cell(esc(l.no), 1, 'text-center font-bold') + cell(esc(l.desc), 7, descCls) +
        cell(amt(l.last, red), 1, 'cnum') + cell(amt(l.this, red), 1, 'cnum cthis') + cell(amt(l.cum, red), 1, 'cnum') + cell(esc(l.remark), 1, 'text-[11px] text-slate-500') + '</tr>';
      rows.push(html);
    });
    rows.push('<tr class="cdue">' + cell('PAYMENT DUE IN THE PERIOD FOR THIS PAYMENT CERTIFICATE:', 9) + cell('', 1) + cell(amt(m.paymentDue), 1, 'cnum cthis') + cell('', 1) + cell('(A − B − C) + VAT', 1, 'text-[11px] font-normal text-slate-500') + '</tr>');
    rows.push('<tr>' + cell('OTHER DEDUCTION', 1, 'cgroup') + cell('13.1', 1, 'text-center font-bold') + cell('Other Deductions (after VAT)', 7, 'font-bold text-rose-600') + cell('', 1) + cell(amt(m.postVatDeduction, true), 1, 'cnum cthis') + cell('', 2) + '</tr>');
    rows.push('<tr class="cdue">' + cell('NET PAYMENT DUE IN THE PERIOD FOR THIS PAYMENT CERTIFICATE:', 9) + cell('', 1) + cell(amt(m.netPaymentDue), 1, 'cnum cthis') + cell('', 2) + '</tr>');
    rows.push('<tr>' + cell('AMOUNT IN WORDS:', 4, 'font-bold') + cell(esc(m.amountInWords), 9, 'cwords') + '</tr>');

    const s = m.signatures;
    rows.push(band('SIGNATURES', 'csection'));
    rows.push(band(s.consultantTitle, 'csub'));
    const four = function (label, vals) {
      return '<tr>' + cell(esc(label), 3, 'cl') + cell(vals[0], 3) + cell(vals[1], 4) + cell(vals[2], 1) + cell(vals[3], 2) + '</tr>';
    };
    rows.push(four('Name :', s.consultant.map(function (x) { return esc(x.name); })));
    rows.push(four('Position :', s.consultant.map(function (x) { return '<b>' + esc(x.position) + '</b>'; })));
    rows.push(four('Signature :', ['', '', '', '']).replace(/<tr>/, '<tr class="csig">'));
    rows.push(four('Date :', s.consultant.map(function (x) { return esc(x.date); })));
    [[s.siteTitle, s.siteDepartment, s.site], [s.homeTitle, s.homeDepartment, s.home]].forEach(function (t) {
      rows.push(band(t[0], 'csub'));
      rows.push('<tr>' + cell('Department', 3, 'cl') + cell(esc(t[1]), 10, 'font-bold') + '</tr>');
      const two = function (label, vals, trCls) {
        return '<tr' + (trCls ? ' class="' + trCls + '"' : '') + '>' + cell(esc(label), 3, 'cl') + cell(vals[0], 7) + cell(vals[1], 3) + '</tr>';
      };
      rows.push(two('Name :', t[2].map(function (x) { return esc(x.name); })));
      rows.push(two('Position :', t[2].map(function (x) { return '<b>' + esc(x.position) + '</b>'; })));
      rows.push(two('Signature :', ['', ''], 'csig'));
      rows.push(two('Date :', t[2].map(function (x) { return esc(x.date); })));
    });

    const total = CERT_COLS.reduce(function (s2, w) { return s2 + w; }, 0);
    const cols = CERT_COLS.map(function (w) { return '<col style="width:' + (w / total * 100).toFixed(2) + '%">'; }).join('');
    $('certSheet').innerHTML = '<table class="cert-table"><colgroup>' + cols + '</colgroup><tbody>' + rows.join('') + '</tbody></table>';

    $('negativeCertNotice').hidden = fin.netPaymentDue >= 0;
    const st = $('certStatusStrip');
    st.textContent = m.application.ipcNo + ' · ' + statusLabel(c);
    st.className = 'text-xs px-2.5 py-1 rounded-full font-semibold ' + STATUS_BADGE[c.approvalStatus];
  }

  function emptyRow(cols, msg) {
    return '<tr><td colspan="' + cols + '" class="py-6 text-center text-slate-400 text-xs">' + esc(msg) + '</td></tr>';
  }

  function renderBoqTable(c, fin) {
    $('boqTableBody').innerHTML = c.boqItems.map(function (item) {
      const prev = num(item.prevQty);
      const total = prev + num(item.thisQty);
      const cq = num(item.contractQty);
      const pct = cq > 0 ? (total / cq) * 100 : 0;
      const overrun = cq > 0 && total > cq + 1e-9;
      const pctClass = overrun ? 'bg-rose-100 text-rose-800' : pct >= 99.9 ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-50 text-blue-700';
      return '<tr class="hover:bg-slate-50 transition' + (overrun ? ' bg-rose-50/40' : '') + '">' +
        '<td class="py-2.5 px-3 font-semibold text-slate-800">' + esc(item.code) + '</td>' +
        '<td class="py-2.5 px-3 font-medium text-slate-900">' + esc(item.desc) +
          (item.linked ? ' <span class="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700" title="' + esc(item.source || '') + '">' + esc(item.src || 'COST') + '</span>' : '') +
          (item.removedFromCostPlan ? ' <span class="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-100 text-rose-800">Removed from cost plan — review</span>' : '') + '</td>' +
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
        '<td class="py-2.5 px-2 text-center no-print">' + (item.linked ? '<span class="text-slate-300" title="Linked to the cost model">🔗</span>' :
          '<button data-action="boq-del" data-id="' + esc(item.id) + '" class="text-rose-400 hover:text-rose-600 p-1" title="Delete item" aria-label="Delete ' + esc(item.code) + '">✕</button>') + '</td>' +
        '</tr>';
    }).join('') || emptyRow(12, 'No BOQ items. Add one to start measuring.');
    renderCostingBanner(c);
    setTxt('boqFooterContractTotal', formatSAR(fin.boqContractTotal));
    setTxt('boqFooterCertifiedTotal', formatSAR(fin.boqCumTotal));
    filterBoqTable();
  }

  function renderCostingBanner(c) {
    const link = c.linkedCosting && c.costingLink;
    ['boqCostingBanner', 'certCostingBanner'].forEach(function (id) {
      const el = $(id);
      if (!el) return;
      el.hidden = !link;
      if (!link) return;
      el.innerHTML = '<strong>Linked to the Crystal Gallery cost model</strong> (Crystal Gallery 4D/5D, commit ' + esc(String(link.commit || '').slice(0, 7)) + '). ' +
        'Contract sum <strong>' + esc(formatSAR(link.outturn)) + '</strong> = out-turn priced BoQ, excl. the ' + esc(String(link.contingencyPct)) + '% contingency reserve (' +
        esc(formatSAR(link.reserve)) + ') and VAT. Quantities and rates update from the cost model; measurement stays here.';
    });
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

  function adjustmentRow(id, line, label, kind, prev, period, cum) {
    const color = kind === 'ded' ? 'text-rose-600' : 'text-emerald-700';
    return '<tr class="hover:bg-slate-50">' +
      '<td class="py-2 px-3 font-bold text-slate-500">' + esc(line) + '</td>' +
      '<td class="py-2 px-3 font-medium text-slate-800">' + esc(label) + ' <span class="text-[10px] uppercase font-bold ' + color + '">' + (kind === 'ded' ? 'deduct' : kind === 'post' ? 'after VAT' : 'add') + '</span></td>' +
      '<td class="py-2 px-3 text-right text-slate-500">' + (prev == null ? '—' : formatNumber(prev)) + '</td>' +
      '<td class="py-1.5 px-2 text-right bg-amber-50/50"><input type="number" step="0.01" value="' + esc(round2(period)) + '" data-action="adj" data-key="' + esc(id) + '" aria-label="' + esc(label) + ' this period"' +
        ' class="w-36 px-2 py-1 text-right text-xs font-bold text-amber-900 bg-white border border-amber-300 rounded"></td>' +
      '<td class="py-2 px-3 text-right font-bold ' + color + '">' + (cum == null ? '—' : formatNumber(cum)) + '</td></tr>';
  }

  function renderDeductions(c, fin) {
    const advPct = fin.advPaid.cum > 0 ? (fin.advRecoveredCum / fin.advPaid.cum) * 100 : 0;
    setTxt('advCardTotalPaid', formatSAR(fin.advPaid.cum) + (fin.advPaid.cum < fin.advTotalPaid ? ' of ' + formatSAR(fin.advTotalPaid) : ''));
    setTxt('advCardCumRecovered', formatSAR(fin.advRecoveredCum));
    setTxt('advCardBalance', formatSAR(fin.advRemainingBalance));
    setTxt('advCardRate', (fin.advRecoveryRate * 100).toFixed(0) + '% of each IPC work value');
    setTxt('advCardPct', advPct.toFixed(1) + '% Complete');
    $('advCardProgressBar').style.width = Math.min(100, advPct) + '%';

    const retPct = fin.retentionCap > 0 ? (fin.retentionCum / fin.retentionCap) * 100 : 0;
    setTxt('retCardRate', (fin.retentionRate * 100).toFixed(0) + '% per certificate');
    setTxt('retCardCapLabel', 'Maximum Retention Limit (' + (fin.retentionCapRate * 100).toFixed(0) + '% Contract Sum):');
    setTxt('retCardCapLimit', formatSAR(fin.retentionCap));
    setTxt('retCardCumWithheld', formatSAR(fin.retentionCum));
    setTxt('retCardReleased', formatSAR(fin.retRelease.cum));
    setTxt('retCardRemainingCap', formatSAR(Math.max(0, fin.retentionCap - fin.retentionCum)));
    setTxt('retCardPct', retPct.toFixed(1) + '% of Cap');
    $('retCardProgressBar').style.width = Math.min(100, retPct) + '%';

    const adjRows = [adjustmentRow('advancePaid', '04', 'Advance payment paid to contractor', 'add', fin.advPaid.prev, fin.advPaid.period, fin.advPaid.cum)];
    ADJUSTMENTS.forEach(function (a) {
      adjRows.push(adjustmentRow(a.key, a.line, a.label, a.kind, num(c[a.key + 'Prev']), num(c[a.key + 'ToDate']) - num(c[a.key + 'Prev']), num(c[a.key + 'ToDate'])));
    });
    adjRows.push(adjustmentRow('postVatDeduction', '13.1', 'Other deduction after VAT (this certificate only)', 'post', null, fin.postVatDeduction, null));
    // Don't clobber a field the user is typing into.
    if (!$('adjTableBody').contains(document.activeElement)) $('adjTableBody').innerHTML = adjRows.join('');

    const hist = c.history.map(function (h, idx) {
      const paid = h.status === 'Disbursed';
      return '<tr class="hover:bg-slate-50">' +
        '<td class="py-2.5 px-3 font-bold">' + esc(h.ipcNo) + '</td>' +
        '<td class="py-2.5 px-3 text-slate-600">' + esc(h.period) + '</td>' +
        '<td class="py-2.5 px-3 text-right">' + formatNumber(h.gross) + '</td>' +
        '<td class="py-2.5 px-3 text-right text-rose-600">' + formatNumber(h.retention) + '</td>' +
        '<td class="py-2.5 px-3 text-right text-rose-600">' + formatNumber(h.advance) + '</td>' +
        '<td class="py-2.5 px-3 text-right text-rose-600">' + formatNumber(h.other) + '</td>' +
        '<td class="py-2.5 px-3 text-right font-medium">' + formatNumber(h.net) + '</td>' +
        '<td class="py-2.5 px-3 text-right">' + formatNumber(h.vat) + '</td>' +
        '<td class="py-2.5 px-3 text-right text-rose-600">' + formatNumber(h.postVat || 0) + '</td>' +
        '<td class="py-2.5 px-3 text-right font-bold text-slate-900">' + formatNumber(h.total) + '</td>' +
        '<td class="py-2.5 px-3 text-center">' + (paid
          ? '<span class="px-2 py-0.5 rounded-full text-[10px] bg-emerald-100 text-emerald-800 font-semibold">Disbursed</span>'
          : '<button data-action="hist-paid" data-idx="' + idx + '" class="px-2 py-0.5 rounded-full text-[10px] bg-blue-100 text-blue-800 font-semibold hover:bg-blue-200" title="Mark as paid">Certified · Mark Paid</button>') +
        '</td></tr>';
    }).join('');
    const current = '<tr class="bg-amber-50/50 font-medium">' +
      '<td class="py-2.5 px-3 font-bold text-amber-900">' + esc(c.currentIpcNo) + ' (Active)</td>' +
      '<td class="py-2.5 px-3 text-slate-700">' + esc(shortMonth(String(c.valuationPeriod).split(' to ')[0])) + '</td>' +
      '<td class="py-2.5 px-3 text-right">' + formatNumber(fin.totalGrossPeriod) + '</td>' +
      '<td class="py-2.5 px-3 text-right text-rose-600">' + formatNumber(fin.retentionPeriod) + '</td>' +
      '<td class="py-2.5 px-3 text-right text-rose-600">' + formatNumber(fin.advRecoveredPeriod) + '</td>' +
      '<td class="py-2.5 px-3 text-right text-rose-600">' + formatNumber(fin.ld.period + fin.otherDeductionsPeriod + fin.otherPay.period) + '</td>' +
      '<td class="py-2.5 px-3 text-right font-bold text-slate-900">' + formatNumber(fin.dueExVat) + '</td>' +
      '<td class="py-2.5 px-3 text-right">' + formatNumber(fin.vatPeriod) + '</td>' +
      '<td class="py-2.5 px-3 text-right text-rose-600">' + formatNumber(fin.postVatDeduction) + '</td>' +
      '<td class="py-2.5 px-3 text-right font-bold text-amber-900">' + formatNumber(fin.netPaymentDue) + '</td>' +
      '<td class="py-2.5 px-3 text-center"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ' + STATUS_BADGE[c.approvalStatus] + '">' + esc(statusLabel(c)) + '</span></td>' +
      '</tr>';
    $('histTableBody').innerHTML = hist + current;
  }

  function renderWorkflow(proj, c) {
    const next = nextStage(c);
    const html = STAGES.map(function (st, i) {
      const done = c.signoffs[st.key];
      const isNext = next && next.key === st.key;
      const icon = done ? '✓' : c.returned ? '!' : String(i + 2);
      const iconCls = done ? 'bg-emerald-600 text-white' : c.returned ? 'bg-rose-600 text-white' : isNext ? 'bg-amber-500 text-white' : 'bg-slate-300 text-slate-600';
      let signers = '';
      if (st.key === 'consultant') {
        signers = CONSULTANT_POSITIONS.map(function (pos, j) { return esc((proj.consultantTeam[j] || '—') + ' · ' + pos); }).join('<br>');
      } else {
        const o = st.key === 'siteOffice' ? state.settings.siteOffice : state.settings.homeOffice;
        signers = o.signatories.map(function (x) { return esc((x.name || '—') + ' · ' + x.position); }).join('<br>');
      }
      return '<div class="flex items-start gap-3 flex-1 min-w-0">' +
        '<div class="w-8 h-8 rounded-full ' + iconCls + ' flex items-center justify-center font-bold text-sm shrink-0">' + icon + '</div>' +
        '<div class="min-w-0"><p class="text-xs font-bold uppercase ' + (done ? 'text-emerald-700' : 'text-slate-500') + '">Stage ' + (i + 2) + '</p>' +
        '<h4 class="font-bold text-slate-900 text-sm">' + esc(st.label) + '</h4>' +
        '<p class="text-[11px] text-slate-500 mt-1 leading-relaxed">' + signers + '</p>' +
        (done ? '<span class="inline-block mt-2 text-[10px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold">Signed ' + esc(done) + '</span>'
          : isNext ? '<button data-action="sign" data-stage="' + st.key + '" class="mt-2 px-2.5 py-1 bg-emerald-600 text-white rounded text-xs font-medium hover:bg-emerald-700 transition">Sign off</button>'
          : '<span class="inline-block mt-2 text-[10px] px-2 py-0.5 rounded bg-slate-100 text-slate-500">Pending</span>') +
        '</div></div>';
    }).join('');
    const finance = c.approvalStatus === 'Approved';
    $('workflowStages').innerHTML =
      '<div class="flex items-start gap-3 flex-1 min-w-0"><div class="w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-sm shrink-0">✓</div>' +
      '<div><p class="text-xs font-bold uppercase text-emerald-700">Stage 1</p><h4 class="font-bold text-slate-900 text-sm">Contractor Application</h4>' +
      '<p class="text-[11px] text-slate-500 mt-1">' + esc(c.repName) + ' · ' + esc(c.repRole) + '</p></div></div>' + html +
      '<div class="flex items-start gap-3 flex-1 min-w-0"><div class="w-8 h-8 rounded-full ' + (finance ? 'bg-amber-500 text-white' : 'bg-slate-300 text-slate-600') + ' flex items-center justify-center font-bold text-sm shrink-0">5</div>' +
      '<div><p class="text-xs font-bold uppercase text-slate-500">Stage 5</p><h4 class="font-bold text-slate-900 text-sm">Finance: Tax Invoice &amp; Pay</h4>' +
      '<span class="inline-block mt-2 text-[10px] px-2 py-0.5 rounded ' + (finance ? 'bg-amber-100 text-amber-800 font-semibold' : 'bg-slate-100 text-slate-500') + '">' + (finance ? 'Ready for payment' : 'Awaiting approval') + '</span></div></div>';

    $('returnedNotice').hidden = !c.returned;
    if (c.returned) setTxt('returnedReason', c.returned.reason + ' (' + c.returned.ts + ')');
    $('btnReturn').disabled = !!c.returned || c.approvalStatus === 'Approved';

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
    setTxt('analyticsDeductions', 'SAR ' + ((fin.retentionCum - fin.retRelease.cum + fin.advRemainingBalance) / 1e6).toFixed(2) + 'M');
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
      retention += f.retentionCum - f.retRelease.cum;
      due += f.netPaymentDue;
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
      const stBadge = STATUS_BADGE[c.approvalStatus];
      const stLabel = statusLabel(c);
      cards.push(
        '<div class="rounded-xl p-5 border transition-all duration-200 ' + (isCurrent ? 'bg-amber-50/60 border-midad-gold shadow-md ring-2 ring-midad-gold/30' : 'bg-white border-slate-200 shadow-sm hover:border-slate-300') + '">' +
        '<div class="flex justify-between items-start gap-2"><div class="min-w-0">' +
        '<div class="flex items-center gap-1.5 flex-wrap"><span class="text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider ' + badge + '">' + esc(c.sector || 'General') + '</span>' +
        '<span class="text-[10px] font-semibold text-slate-500">' + esc(c.tradeCategory) + '</span></div>' +
        '<h4 class="font-bold text-slate-900 text-sm mt-2">' + esc(c.companyName) + '</h4>' +
        '<p class="text-xs text-slate-600 font-medium">' + esc(c.package) + '</p>' +
        '<p class="text-[11px] text-slate-400 mt-0.5 font-mono">' + esc(c.contractRef) + '</p></div>' +
        '<span class="text-[11px] px-2 py-0.5 rounded font-semibold text-right ' + stBadge + '">' + esc(stLabel) + '</span></div>' +
        '<div class="mt-4 pt-3 border-t border-slate-200 grid grid-cols-2 gap-2 text-xs">' +
        '<div><span class="text-slate-500 block text-[10px] uppercase font-semibold">Revised Sum</span><span class="font-bold text-slate-800">' + formatSAR(f.revisedContractSum) + '</span></div>' +
        '<div><span class="text-slate-500 block text-[10px] uppercase font-semibold">Net Payment Due</span><span class="font-bold text-midad-gold">' + formatSAR(f.netPaymentDue) + '</span></div></div>' +
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
        '<td class="py-3 px-3 text-right text-rose-600">(' + formatSAR(f.retentionCum - f.retRelease.cum) + ')</td>' +
        '<td class="py-3 px-3 text-right font-bold text-midad-gold bg-amber-50/60">' + formatSAR(f.netPaymentDue) + '</td>' +
        '<td class="py-3 px-2 text-center"><span class="px-2 py-0.5 rounded text-[10px] font-bold ' + stBadge + '">' + esc(stLabel) + '</span></td>' +
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
    // Work value per IPC excludes the IPC-00 advance (an advance is not progress).
    const byNo = {};
    c.history.forEach(function (h) { byNo[parseIpcNo(h.ipcNo)] = h; });
    const labels = [], plannedCurve = [], actualCurve = [];
    let cum = 0;
    for (let k = 1; k <= n; k++) {
      labels.push(formatIpcNo(k) + (k === current ? ' (Now)' : ''));
      plannedCurve.push(+(fin.revisedContractSum * logisticShare(Math.min(1, k / planned)) / 1e6).toFixed(2));
      if (k < current && byNo[k]) {
        cum += byNo[k].gross;
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
          { label: 'Actual certified work value', data: actualCurve, borderColor: '#c5a059', backgroundColor: 'rgba(197,160,89,0.15)', borderWidth: 3, tension: 0.3, fill: true, pointRadius: 3, pointBackgroundColor: '#0f172a' }
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
    const cfData = c.history.map(function (h) { return +(h.total / 1e6).toFixed(2); }).concat([+(fin.netPaymentDue / 1e6).toFixed(2)]);
    const cfColors = c.history.map(function (h) { return h.status === 'Disbursed' ? '#0f172a' : '#3b82f6'; }).concat(['#c5a059']);
    if (cashflowChart) cashflowChart.destroy();
    cashflowChart = new window.Chart($('cashflowChart'), {
      type: 'bar',
      data: { labels: cfLabels, datasets: [{ label: 'Net payment incl. VAT (SAR M)', data: cfData, backgroundColor: cfColors, borderRadius: 6 }] },
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

  function openDetailsModal() {
    const c = activeContractor();
    if (!c) return;
    $('detailsFields').innerHTML = DETAIL_FIELDS.map(function (f) {
      const v = f[2] === 'date' ? dmyToIso(c[f[0]]) : (c[f[0]] == null ? '' : c[f[0]]);
      return '<label class="block"><span class="block font-semibold text-slate-700 mb-1">' + esc(f[1]) + (f[3] ? ' *' : '') + '</span>' +
        '<input data-field="' + f[0] + '" type="' + (f[2] === 'number' ? 'number" step="0.01" min="0' : f[2]) + '" value="' + esc(v) + '"' + (f[3] ? ' required' : '') +
        ' class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-midad-gold outline-none"></label>';
    }).join('');
    openModal('detailsModal');
  }

  function handleSaveDetails(e) {
    e.preventDefault();
    const c = activeContractor();
    $('detailsFields').querySelectorAll('input[data-field]').forEach(function (inp) {
      const f = DETAIL_FIELDS.find(function (x) { return x[0] === inp.getAttribute('data-field'); });
      c[f[0]] = f[2] === 'date' ? isoToDmy(inp.value) : f[2] === 'number' ? Math.max(0, num(inp.value)) : inp.value.trim();
    });
    addAudit(c, 'blue', 'Contract & payment details updated', 'Certificate header fields edited.');
    closeModal('detailsModal');
    commit();
    showToast('Contract details saved', 'success');
  }

  function openSettingsModal() {
    const s = state.settings;
    const p = activeProject();
    $('setEmployer').value = s.employerName;
    $('setConsultantProject').textContent = p.consultant;
    $('setConsultantTeam').innerHTML = CONSULTANT_POSITIONS.map(function (pos, i) {
      return '<label class="block"><span class="block font-semibold text-slate-700 mb-1">' + esc(pos) + '</span>' +
        '<input data-team="' + i + '" type="text" value="' + esc(p.consultantTeam[i] || '') + '" class="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-midad-gold outline-none"></label>';
    }).join('');
    [['site', s.siteOffice], ['home', s.homeOffice]].forEach(function (t) {
      $('set_' + t[0] + '_dept').value = t[1].department;
      t[1].signatories.forEach(function (x, i) {
        $('set_' + t[0] + '_name' + i).value = x.name;
        $('set_' + t[0] + '_pos' + i).value = x.position;
      });
    });
    openModal('settingsModal');
  }

  function handleSaveSettings(e) {
    e.preventDefault();
    const s = state.settings;
    const p = activeProject();
    s.employerName = $('setEmployer').value.trim() || 'ASCTO';
    $('setConsultantTeam').querySelectorAll('input[data-team]').forEach(function (inp) {
      p.consultantTeam[parseInt(inp.getAttribute('data-team'), 10)] = inp.value.trim();
    });
    [['site', s.siteOffice], ['home', s.homeOffice]].forEach(function (t) {
      t[1].department = $('set_' + t[0] + '_dept').value.trim();
      t[1].signatories.forEach(function (x, i) {
        x.name = $('set_' + t[0] + '_name' + i).value.trim();
        x.position = $('set_' + t[0] + '_pos' + i).value.trim();
      });
    });
    closeModal('settingsModal');
    commit();
    showToast('Signatories saved', 'success');
  }

  /* ================= In-page dialogs & file saving ================= */
  // Native confirm()/prompt() are unavailable in embedded viewers (they return false/null immediately),
  // so confirmations are built into the page.

  let dialogState = null;

  function askDialog(message, opts) {
    return new Promise(function (resolve) {
      if (dialogState) dialogState.resolve(null);
      dialogState = { resolve: resolve, input: !!opts.input };
      setTxt('dialogMessage', message);
      const inp = $('dialogInput');
      inp.hidden = !opts.input;
      inp.value = opts.value || '';
      const ok = $('dialogConfirm');
      ok.textContent = opts.confirmLabel || 'Confirm';
      ok.className = 'px-4 py-2 text-white font-semibold rounded-lg ' + (opts.danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-700 hover:bg-emerald-800');
      openModal('dialogModal');
      (opts.input ? inp : ok).focus();
    });
  }

  function closeDialog(result) {
    closeModal('dialogModal');
    const d = dialogState;
    dialogState = null;
    if (d) d.resolve(result);
  }

  function askConfirm(message, confirmLabel, danger) {
    return askDialog(message, { confirmLabel: confirmLabel, danger: danger }).then(function (r) { return r === true; });
  }

  function askText(message, value, confirmLabel) {
    return askDialog(message, { input: true, value: value, confirmLabel: confirmLabel, danger: true });
  }

  function inViewer() {
    return !!(window.claude && typeof window.claude.use === 'function');
  }

  // Inside the claude.ai viewer, files go through the viewer's save confirmation (downloads capability);
  // elsewhere, a normal browser download. Resolves 'saved' or 'declined'.
  async function saveFile(filename, data) {
    if (inViewer()) {
      const downloads = await window.claude.use('downloads');
      if (!downloads) throw new Error('saving files is not available in this view');
      try {
        await downloads.save({ filename: filename, data: data });
        return 'saved';
      } catch (err) {
        if (err && err.code === 'declined') return 'declined';
        throw new Error((err && err.message) || 'save failed');
      }
    }
    const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return 'saved';
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
    const advance = Math.max(0, optionalNumber('modalContractorAdv', sum * 0.10));

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
      advancePaymentOriginal: advance,
      advanceRecoveryRate: Math.max(0, optionalNumber('modalContractorAdvRate', 10)) / 100,
      retentionRate: Math.max(0, optionalNumber('modalContractorRetRate', 10)) / 100,
      retentionCapRate: Math.max(0, optionalNumber('modalContractorRetCap', 5)) / 100,
      vatRate: 0.15,
      // With an advance, the first certificate is IPC-00 (advance payment), as in the template.
      currentIpcNo: advance > 0 ? 'IPC-00' : 'IPC-01',
      paymentType: advance > 0 ? 'Advance Payment' : 'Interim Payment',
      advancePaidPrev: 0,
      advancePaidToDate: advance,
      valuationPeriod: addMonths(today, -1).replace(/^\d+/, '01') + ' to ' + today,
      issueDate: today,
      invoiceDate: today,
      valuationDate: today,
      otherDeductionsToDate: 0,
      otherDeductionsPrev: 0,
      signoffs: { consultant: null, siteOffice: null, homeOffice: null },
      returned: null,
      boqItems: [
        { id: 1, code: '01.00', desc: 'Preliminaries, Site Engineering & Mobilization', unit: 'LS', rate: sum * 0.15, contractQty: 1, prevQty: 0, thisQty: 0 },
        { id: 2, code: '02.00', desc: 'Primary Scope Execution', unit: 'LS', rate: sum * 0.85, contractQty: 1, prevQty: 0, thisQty: 0 }
      ],
      variations: [],
      mos: [],
      history: [],
      audit: []
    };
    normalizeContractor(c);
    addAudit(c, 'blue', 'Contractor package enlisted', company + ' registered under ' + c.contractRef + '. Replace the placeholder BOQ with the priced bill.');
    proj.contractors.push(c);
    proj.activeContractorId = c.id;
    closeModal('contractorModal');
    e.target.reset();
    commit();
    switchTab(advance > 0 ? 'certificate' : 'boq');
    showToast('Package "' + company + '" registered' + (advance > 0 ? ' — IPC-00 advance payment certificate created.' : '.'), 'success');
  }

  function handleSaveBoqItem(e) {
    e.preventDefault();
    const c = activeContractor();
    if (!c) return;
    if (c.linkedCosting) {
      closeModal('boqModal');
      return showToast('This BoQ is linked to the cost model. Add new scope as a Variation Order instead.', 'warning');
    }
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
    valuationChanged(c, 'BOQ');
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
    if (status === 'Approved') valuationChanged(c, 'Variations');
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
    valuationChanged(c, 'Materials on site');
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
    valuationChanged(c, 'BOQ quantity ' + item.code);
    commit();
    if (item.thisQty !== q) showToast('Quantity limited so cumulative is not below zero.', 'warning');
  }

  function onVoPct(id, value) {
    const c = activeContractor();
    const vo = c && findById(c.variations, id);
    if (!vo) return;
    vo.progressPct = Math.min(100, Math.max(0, num(value)));
    valuationChanged(c, 'Variation ' + vo.code);
    commit();
  }

  function onMosQty(id, value) {
    const c = activeContractor();
    const m = c && findById(c.mos, id);
    if (!m) return;
    m.qty = Math.max(0, num(value));
    valuationChanged(c, 'MOS ' + m.code);
    commit();
  }

  function onAdjustment(key, value) {
    const c = activeContractor();
    if (!c) return;
    const v = round2(num(value));
    let label;
    if (key === 'postVatDeduction') {
      c.postVatDeduction = v;
      label = 'Other deduction after VAT (13.1)';
    } else if (key === 'advancePaid') {
      c.advancePaidToDate = Math.max(0, num(c.advancePaidPrev) + v);
      label = 'Advance payment (04)';
    } else {
      const a = ADJUSTMENTS.find(function (x) { return x.key === key; });
      if (!a) return;
      c[key + 'ToDate'] = num(c[key + 'Prev']) + v;
      label = a.label + ' (' + a.line + ')';
    }
    addAudit(c, 'amber', label + ' this period set to ' + formatSAR(v), c.currentIpcNo + ' adjustment.');
    valuationChanged(c, label);
    commit();
  }

  async function deleteFrom(listName, id, label) {
    const c = activeContractor();
    const item = c && findById(c[listName], id);
    if (!item) return;
    if (item.linked) return showToast(item.code + ' comes from the Crystal Gallery cost model. Change it there and re-sync; contract changes after award go in as variations.', 'warning');
    if (!await askConfirm('Delete ' + label + ' ' + item.code + '? This cannot be undone.', 'Delete', true)) return;
    c[listName] = c[listName].filter(function (x) { return String(x.id) !== String(id); });
    addAudit(c, 'red', label + ' ' + item.code + ' deleted', item.desc || '');
    valuationChanged(c, label + ' ' + item.code);
    commit();
    showToast(label + ' ' + item.code + ' removed', 'warning');
  }

  function toggleVoStatus(id) {
    const c = activeContractor();
    const vo = c && findById(c.variations, id);
    if (!vo) return;
    vo.status = vo.status === 'Approved' ? 'Pending' : 'Approved';
    addAudit(c, 'amber', 'Variation ' + vo.code + ' set to ' + vo.status, vo.status === 'Approved' ? 'Now included in revised contract sum and valuation.' : 'Excluded from valuation until approved.');
    valuationChanged(c, 'Variation ' + vo.code + ' status');
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

  async function signStage(key) {
    const c = activeContractor();
    if (!c) return;
    const n = nextStage(c);
    if (!n || n.key !== key) return;
    const fin = calc(c);
    if (!await askConfirm(n.label + ': sign ' + c.currentIpcNo + ' for a net payment due of ' + formatSAR(fin.netPaymentDue) + '?', 'Sign off')) return;
    c.signoffs[key] = todayDMY();
    syncStatus(c);
    addAudit(c, 'green', n.label + ' signed for ' + c.currentIpcNo, n.who + ' signed. Net payment due ' + formatSAR(fin.netPaymentDue) + '.');
    commit();
    showToast(n.label + ' signed' + (c.approvalStatus === 'Approved' ? ' — certificate approved for payment.' : '.'), 'success');
  }

  async function returnIpc() {
    const c = activeContractor();
    if (!c || c.returned || c.approvalStatus === 'Approved') return;
    const reason = await askText('Reason for returning ' + c.currentIpcNo + ' to the contractor:', 'Measurement clarification required', 'Return IPC');
    if (reason === null) return;
    c.returned = { reason: reason || 'No reason given', ts: todayDMY() };
    c.signoffs = { consultant: null, siteOffice: null, homeOffice: null };
    syncStatus(c);
    addAudit(c, 'red', c.currentIpcNo + ' returned with snags', c.returned.reason);
    commit();
    showToast(c.currentIpcNo + ' returned to ' + c.companyName, 'warning');
  }

  function resubmitIpc() {
    const c = activeContractor();
    if (!c || !c.returned) return;
    c.returned = null;
    syncStatus(c);
    addAudit(c, 'blue', c.currentIpcNo + ' resubmitted', 'Contractor resubmitted after addressing snags.');
    commit();
  }

  async function newIpcCycle() {
    const c = activeContractor();
    if (!c) return;
    if (c.approvalStatus !== 'Approved') {
      showToast(c.currentIpcNo + ' needs all three sign-offs before the next cycle can open (Verification & Approvals tab).', 'warning');
      switchTab('workflow');
      return;
    }
    const fin = calc(c);
    const nextNo = formatIpcNo(parseIpcNo(c.currentIpcNo) + 1);
    if (!await askConfirm('Close ' + c.currentIpcNo + ' (net payment due ' + formatSAR(fin.netPaymentDue) + ') and open ' + nextNo + '? Current figures will be locked as "last period".', 'Open ' + nextNo)) return;

    c.history.push(historyRow(c.currentIpcNo, shortMonth(String(c.valuationPeriod).split(' to ')[0]), {
      gross: fin.totalGrossPeriod,
      retention: fin.retentionPeriod,
      advance: fin.advRecoveredPeriod,
      other: fin.ld.period + fin.otherDeductionsPeriod + fin.otherPay.period,
      net: fin.dueExVat,
      vat: fin.vatPeriod,
      postVat: fin.postVatDeduction,
      total: fin.netPaymentDue,
      status: 'Certified'
    }));
    c.boqItems.forEach(function (i) { i.prevQty = num(i.prevQty) + num(i.thisQty); i.thisQty = 0; });
    c.variations.forEach(function (v) { v.prevPct = num(v.progressPct); });
    c.mos.forEach(function (m) { m.prevQty = num(m.qty); });
    ADJUSTMENTS.forEach(function (a) { c[a.key + 'Prev'] = num(c[a.key + 'ToDate']); });
    c.advancePaidPrev = num(c.advancePaidToDate);
    c.postVatDeduction = 0;

    const parts = String(c.valuationPeriod).split(' to ');
    const wasAdvance = parseIpcNo(c.currentIpcNo) === 0;
    c.valuationPeriod = addMonths(parts[0], 1) + ' to ' + addMonths(parts[1] || parts[0], 1);
    c.issueDate = addMonths(c.issueDate, 1);
    c.invoiceDate = c.issueDate;
    c.valuationDate = periodEnd(c);
    c.taxInvoiceNo = '';
    c.paymentType = 'Interim Payment';
    c.currentIpcNo = nextNo;
    c.signoffs = { consultant: null, siteOffice: null, homeOffice: null };
    c.returned = null;
    syncStatus(c);
    addAudit(c, 'gold', 'New valuation cycle opened: ' + nextNo, 'Previous figures locked for ' + c.package + '. Ready for new measurements.');
    commit();
    switchTab('boq');
    showToast('Opened ' + nextNo + ' for ' + c.companyName + (wasAdvance ? ' — first interim valuation.' : ''), 'success');
  }

  async function exportExcel() {
    const c = activeContractor();
    if (!c) return;
    const btn = $('btnExcel');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Preparing…';
    try {
      const model = buildCertificate(state.settings, activeProject(), c, calc(c));
      const safeRef = String(c.contractRef || c.companyName).replace(/[^A-Za-z0-9_-]+/g, '_');
      const blob = await window.IPCExport.buildCertificateXlsx(model);
      const result = await saveFile(model.sheetName + '_' + safeRef + '.xlsx', blob);
      if (result === 'declined') return showToast('Excel download cancelled.', 'info');
      addAudit(c, 'blue', 'Excel certificate exported', model.application.ipcNo + ' exported to the official template.');
      saveState();
      showToast('Excel certificate saved (official template).', 'success');
    } catch (err) {
      showToast('Excel export failed: ' + err.message, 'warning');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function resetDemo() {
    if (!await askConfirm('Reset all projects, contractors and IPC history to the demo data? Your changes will be lost — use Backup first if you need them.', 'Reset demo', true)) return;
    state = freshState();
    activeSectorFilter = 'all';
    commit();
    showToast('Demo data restored', 'info');
  }

  async function exportData() {
    try {
      const result = await saveFile('ascto-ipc-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(state, null, 2));
      if (result !== 'declined') showToast('Backup saved.', 'success');
    } catch (err) {
      showToast('Backup failed: ' + err.message, 'warning');
    }
  }

  function importData(file) {
    if (!file) return;
    file.text().then(function (txt) {
      const s = JSON.parse(txt);
      if (!isValidState(s)) throw new Error('missing projects');
      state = normalizeState(s);
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
      showToast('Active contractor: ' + activeContractor().companyName, 'info');
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
      btnPrintCert: printCertificate,
      btnExcel: exportExcel,
      btnEditDetails: openDetailsModal,
      btnSettings: openSettingsModal,
      btnSettingsWf: openSettingsModal,
      btnNewIpc: newIpcCycle,
      btnAddBoq: function () { openModal('boqModal'); },
      btnAddVo: function () { openModal('voModal'); },
      btnAddMos: function () { openModal('mosModal'); },
      btnResetDemo: resetDemo,
      btnExport: exportData,
      btnImport: function () { $('importFile').click(); },
      btnReturn: returnIpc,
      btnResubmit: resubmitIpc
    };
    Object.keys(clicks).forEach(function (id) { $(id).addEventListener('click', clicks[id]); });

    $('importFile').addEventListener('change', function (e) {
      importData(e.target.files[0]);
      e.target.value = '';
    });
    $('boqSearch').addEventListener('input', filterBoqTable);

    $('contractorForm').addEventListener('submit', handleSaveContractor);
    $('boqForm').addEventListener('submit', handleSaveBoqItem);
    $('voForm').addEventListener('submit', handleSaveVo);
    $('mosForm').addEventListener('submit', handleSaveMos);
    $('detailsForm').addEventListener('submit', handleSaveDetails);
    $('settingsForm').addEventListener('submit', handleSaveSettings);
    $('dialogForm').addEventListener('submit', function (e) {
      e.preventDefault();
      closeDialog(dialogState && dialogState.input ? $('dialogInput').value.trim() : true);
    });
    $('dialogCancel').addEventListener('click', function () { closeDialog(null); });

    // Delegated handlers for dynamically rendered rows.
    document.addEventListener('change', function (e) {
      const t = e.target;
      const a = t.getAttribute && t.getAttribute('data-action');
      const id = t.getAttribute && t.getAttribute('data-id');
      if (a === 'boq-qty') onBoqQty(id, t.value);
      else if (a === 'vo-pct') onVoPct(id, t.value);
      else if (a === 'mos-qty') onMosQty(id, t.value);
      else if (a === 'adj') { t.blur(); onAdjustment(t.getAttribute('data-key'), t.value); }
    });
    document.addEventListener('click', function (e) {
      const el = e.target.closest && e.target.closest('[data-action]');
      if (!el) {
        if (e.target.classList && e.target.classList.contains('modal-backdrop')) {
          if (e.target.id === 'dialogModal') closeDialog(null); else closeModal(e.target.id);
        }
        return;
      }
      const a = el.getAttribute('data-action');
      const id = el.getAttribute('data-id');
      if (a === 'boq-del') deleteFrom('boqItems', id, 'BOQ item');
      else if (a === 'vo-del') deleteFrom('variations', id, 'Variation');
      else if (a === 'mos-del') deleteFrom('mos', id, 'MOS consignment');
      else if (a === 'vo-status') toggleVoStatus(id);
      else if (a === 'hist-paid') markHistoryPaid(parseInt(el.getAttribute('data-idx'), 10));
      else if (a === 'sign') signStage(el.getAttribute('data-stage'));
      else if (a === 'open-ipc') { switchContractor(id); switchTab('certificate'); }
      else if (a === 'close-modal') closeModal(el.getAttribute('data-target'));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.modal-backdrop').forEach(function (m) {
        if (m.classList.contains('hidden')) return;
        if (m.id === 'dialogModal') closeDialog(null); else closeModal(m.id);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    state = loadState();
    // The claude.ai viewer cannot open the print dialog; Excel export covers the official copy there.
    if (inViewer()) document.querySelectorAll('.print-action').forEach(function (b) { b.hidden = true; });
    bindEvents();
    saveState();
    renderApp();
    switchTab('contractors');
  });
})();
