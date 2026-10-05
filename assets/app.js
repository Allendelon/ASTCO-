/*
 * Midad Executive Suite — UI controller.
 * Depends on: Chart.js 4.4.0 (window.Chart), MIDAD_DATA, CG_COSTING, MidadEngine, MidadAdapters.
 */
(function () {
  'use strict';
  const E = window.MidadEngine;
  const A = window.MidadAdapters;
  const STORE_KEY = 'midad-exec/v1';
  const THEME_KEY = 'midad-exec/theme';
  const FEEDS = { 'crystal-gallery-costing': window.CG_COSTING };

  /* ---------------- Utilities ---------------- */
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const NF = [nf(0), nf(1), nf(2)];
  const sarM = (x, d = 1) => `SAR ${NF[d].format(x)}M`;
  const signedM = (x, d = 1) => `${x > 0 ? '+' : x < 0 ? '−' : ''}SAR ${NF[d].format(Math.abs(x))}M`;
  const sar = x => `SAR ${NF[0].format(Math.round(x * 1e6))}`;
  const pct = (x, d = 0) => `${NF[d].format(x * 100)}%`;
  const idx = x => (x == null ? '—' : x.toFixed(2));
  const RAG_WORD = { G: 'On track', A: 'At risk', R: 'Off track' };
  const ragChip = (r, label) => `<span class="rag rag-${r}" title="${RAG_WORD[r]}">${esc(label || RAG_WORD[r])}</span>`;
  const deltaClass = x => (x > 0.005 ? 'delta-bad' : x < -0.005 ? 'delta-good' : 'muted');

  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* storage unavailable: keep in memory */ }
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 260); }, 3200);
  }

  // Hosted (claude.ai) build: the viewer blocks print dialogs and direct downloads.
  const HOSTED = window.MIDAD_HOSTED === true;
  let downloadsApi;
  async function download(name, text, type) {
    if (HOSTED) {
      if (downloadsApi === undefined) {
        downloadsApi = window.claude && typeof window.claude.use === 'function' ? await window.claude.use('downloads') : null;
      }
      if (!downloadsApi) { toast('File downloads are not available in this view.'); return false; }
      try { await downloadsApi.save({ filename: name, data: text }); return true; }
      catch (e) {
        if (e && e.code === 'declined') return false;
        toast(e && e.code === 'rate_limited' ? 'A save prompt is already open.' : 'The file could not be saved here.');
        return false;
      }
    }
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  const csvCell = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

  /* ---------------- State ---------------- */
  let store = loadStore();
  const state = {
    view: 'portfolio', projectId: 'p1', riskScope: 'portfolio', chartMode: 'cumulative', search: '',
    scenario: { ...E.DEFAULT_SCENARIO },
    projects: [], byId: {}, m: {}, mc: {}, rag: {}, exc: {}, issues: {}, portfolio: null
  };
  const charts = {};

  function buildProjects() {
    const D = window.MIDAD_DATA;
    const list = JSON.parse(JSON.stringify(D.projects));
    D.linkedProjects.forEach(l => {
      const feed = FEEDS[l.feed];
      if (feed) list.push(A.projectFromCosting(feed, JSON.parse(JSON.stringify(l.meta))));
    });
    // Viewer-imported feeds (midad-feed/1) replace or add projects.
    Object.values(store.feeds || {}).forEach(fp => {
      const i = list.findIndex(p => p.id === fp.id);
      if (i >= 0) list[i] = JSON.parse(JSON.stringify(fp)); else list.push(JSON.parse(JSON.stringify(fp)));
    });
    list.forEach(p => {
      const ov = (store.overrides || {})[p.id];
      if (ov) Object.assign(p, JSON.parse(JSON.stringify(ov)));
      (store.added?.[p.id] || []).forEach(c => p.commitments.push({ ...c }));
      const extra = store.actualAdds?.[p.id] || 0;
      if (extra) {
        if (!p.monthlyActual.length) p.monthlyActual.push(0);
        p.monthlyActual[p.monthlyActual.length - 1] += extra;
      }
      p.stage = p.stage || 'Construction';
    });
    state.projects = list;
    state.byId = Object.fromEntries(list.map(p => [p.id, p]));
    if (!state.byId[state.projectId]) state.projectId = list[0].id;
  }

  function compute() {
    const rr = window.MIDAD_DATA.retentionRate;
    state.projects.forEach(p => {
      const m = E.projectMetrics(p, { retentionRate: rr });
      const mc = E.monteCarlo(p, m, E.DEFAULT_SCENARIO);
      state.m[p.id] = m; state.mc[p.id] = mc;
      state.rag[p.id] = E.rag(m, mc);
      state.exc[p.id] = E.exceptions(p, m, mc);
      state.issues[p.id] = E.integrityChecks(p, m);
    });
    const P = state.projects, M = state.m;
    const tot = k => E.sum(P, p => M[p.id][k]);
    const bac = E.sum(P, p => p.bac);
    const pmc = E.portfolioMonteCarlo(P.map(p => state.mc[p.id]), bac);
    const cf = E.portfolioCashflow(P, M);
    const spiW = E.sum(P, p => M[p.id].ev) / Math.max(1e-9, E.sum(P, p => M[p.id].pv));
    const cpiW = E.sum(P, p => M[p.id].ev) / Math.max(1e-9, E.sum(P, p => M[p.id].ac));
    state.portfolio = {
      bac, eac: tot('eac'), committed: tot('committed'), certified: tot('certified'), retention: tot('retention'),
      contRemaining: tot('contRemaining'), overrunPressure: tot('overrunPressure'), headroom: bac - tot('eac'),
      uncommitted: tot('uncommitted'), mc: pmc, cf, spi: spiW, cpi: cpiW,
      exceptions: P.flatMap(p => state.exc[p.id]).sort((a, b) => (b.sev === 'R') - (a.sev === 'R') || b.value - a.value)
    };
  }

  /* ---------------- Charts ---------------- */
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function palette() {
    return {
      series: [css('--s1'), css('--s2'), css('--s3'), css('--s4'), css('--s5')],
      base: css('--s-base'), actual: css('--s1'), forecast: css('--s2'),
      grid: css('--grid'), axis: css('--axis'), muted: css('--muted'), ink: css('--ink'), surface: css('--surface'),
      crit: css('--crit'), warn: css('--warn'), good: css('--good')
    };
  }
  function baseOptions(c, yFmt = v => `${v}`) {
    return {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { padding: 10, boxPadding: 4 } },
      scales: {
        x: { grid: { display: false }, border: { color: c.axis }, ticks: { color: c.muted, maxRotation: 0, autoSkipPadding: 12 } },
        y: { grid: { color: c.grid }, border: { display: false }, ticks: { color: c.muted, callback: yFmt } }
      }
    };
  }
  function draw(key, canvasId, config) {
    if (charts[key]) charts[key].destroy();
    const el = $(canvasId);
    if (!el || typeof Chart === 'undefined') return;
    charts[key] = new Chart(el.getContext('2d'), config);
  }
  const chartUnavailable = () => (typeof Chart === 'undefined'
    ? '<div class="note warn">Charts could not load (Chart.js CDN unreachable). Figures and tables below are unaffected.</div>' : '');

  /* ---------------- Views ---------------- */
  function kpi(label, value, foot, valueClass = '') {
    return `<div class="card kpi"><div class="label">${label}</div><div class="value num ${valueClass}">${value}</div><div class="foot">${foot}</div></div>`;
  }

  function renderPortfolio() {
    const P = state.portfolio;
    const head = `
      <div class="view-head">
        <div><h1>Portfolio overview</h1>
          <p class="lede">${state.projects.length} capital projects · ${sarM(P.bac)} approved. Figures reconcile to the cost ledger; RAG thresholds are stated under Risk &amp; scenarios.</p></div>
        <div class="actions no-print"><button class="btn" id="csv-portfolio" type="button">Export CSV</button></div>
      </div>`;
    const kpis = `<div class="grid g-kpi">
      ${kpi('Approved budget (BAC)', sarM(P.bac), `<span>${state.projects.length} projects</span><span class="muted">incl. contingency</span>`)}
      ${kpi('Forecast final cost', sarM(P.eac), `<span class="${P.headroom < 0 ? 'delta-bad' : 'delta-good'}">${signedM(-P.headroom)} vs BAC</span><span class="muted">bottom-up EAC</span>`)}
      ${kpi('Confidence within BAC', pct(P.mc.probWithinBac), `<span>P80 ${sarM(P.mc.p80)}</span><span class="muted">risk-adjusted</span>`, P.mc.probWithinBac < 0.5 ? 'delta-bad' : P.mc.probWithinBac < 0.8 ? 'delta-warn' : 'delta-good')}
      ${kpi('Committed', pct(P.committed / P.bac), `<span>${sarM(P.committed)}</span><span class="muted">${sarM(P.uncommitted)} uncommitted</span>`)}
      ${kpi('Certified to date', sarM(P.certified), `<span>CPI ${idx(P.cpi)} · SPI ${idx(P.spi)}</span><span class="muted">retention ${sarM(P.retention)}</span>`)}
      ${kpi('Contingency remaining', sarM(P.contRemaining), `<span class="${P.overrunPressure > P.contRemaining ? 'delta-bad' : ''}">${sarM(P.overrunPressure)} already forecast to draw</span>`)}
    </div>`;

    const rows = state.projects.map(p => {
      const m = state.m[p.id], mc = state.mc[p.id], r = state.rag[p.id];
      return `<tr class="clickable" data-open-project="${p.id}" tabindex="0">
        <td style="min-width:200px"><div style="font-weight:700">${esc(p.name)}</div><div class="muted" style="font-size:12px">${esc(p.sector)} · ${esc(p.stage)}</div></td>
        <td class="r num">${sarM(p.bac)}</td>
        <td class="r num">${sarM(m.eac)}</td>
        <td class="r num ${m.headroom < 0 ? 'delta-bad' : ''}">${sarM(m.headroom)}</td>
        <td class="r num">${pct(m.pctComplete)}</td>
        <td class="r num">${m.ac > 0 ? idx(m.cpi) : '—'}</td>
        <td class="r num">${m.pv > 0 ? idx(m.spi) : '—'}</td>
        <td class="r num">${pct(mc.probWithinBac)}</td>
        <td class="c">${ragChip(r.cost, RAG_WORD[r.cost])}</td>
        <td class="c">${ragChip(r.schedule, RAG_WORD[r.schedule])}</td>
        <td class="c">${ragChip(r.overall)}</td>
      </tr>`;
    }).join('');
    const table = `<div class="card flush">
      <div class="card-head"><div><h2>Project health</h2><div class="card-sub">Select a project to review. SAR millions.</div></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Project</th><th class="r">BAC</th><th class="r">Forecast</th><th class="r">Headroom</th><th class="r">Complete</th><th class="r">CPI</th><th class="r">SPI</th><th class="r">P(≤BAC)</th><th class="c">Cost</th><th class="c">Schedule</th><th class="c">Overall</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Portfolio</td><td class="r num">${sarM(P.bac)}</td><td class="r num">${sarM(P.eac)}</td><td class="r num">${sarM(P.headroom)}</td><td></td><td class="r num">${idx(P.cpi)}</td><td class="r num">${idx(P.spi)}</td><td class="r num">${pct(P.mc.probWithinBac)}</td><td colspan="3"></td></tr></tfoot>
      </table></div></div>`;

    const decisions = P.exceptions.slice(0, 8).map(e => `
      <li class="decision">${ragChip(e.sev, e.sev === 'R' ? 'Urgent' : 'Review')}
        <div><div class="what">${esc(e.title)}</div>
          <div class="meta">${esc(e.project)} · ${esc(e.kind)}</div>
          <div class="ask"><b>Ask:</b> ${esc(e.ask)}</div></div></li>`).join('');
    const decisionCard = `<div class="card"><div class="card-head"><div><h2>Decisions required</h2>
      <div class="card-sub">${P.exceptions.length} exceptions raised by rule; top ${Math.min(8, P.exceptions.length)} shown, urgent first</div></div></div>
      <ul class="decisions">${decisions || '<li class="note ok">No exceptions against current thresholds.</li>'}</ul></div>`;

    // Next-12-month funding requirement
    const cf = P.cf;
    const now = E.monthIndex(window.MIDAD_DATA.reportingPeriod);
    const fwd = cf.months.map((mi, i) => ({ mi, i })).filter(x => x.mi > now && x.mi <= now + 12);
    const next3 = E.sum(fwd.slice(0, 3), x => E.sum(cf.byProject, b => b.forecast[x.i]));
    const next12 = E.sum(fwd, x => E.sum(cf.byProject, b => b.forecast[x.i]));

    const c = palette();
    const legendProjects = state.projects.map((p, i) => `<span><i class="box" style="background:${c.series[i % c.series.length]}"></i>${esc(p.name)}</span>`).join('');
    const charts1 = `<div class="grid g-1-1">
      <div class="card"><div class="card-head"><div><h2>Portfolio cash flow (cumulative)</h2><div class="card-sub">Baseline plan vs certified vs forecast · SAR millions</div></div></div>
        ${chartUnavailable()}<div class="chart"><canvas id="ch-port-s"></canvas></div>
        <div class="legend"><span><i style="background:${c.base}"></i>Baseline</span><span><i style="background:${c.actual}"></i>Certified</span><span><i class="dash" style="color:${c.forecast}"></i>Forecast</span></div></div>
      <div class="card"><div class="card-head"><div><h2>Funding requirement — next 12 months</h2><div class="card-sub">Forecast monthly capital calls by project · SAR millions</div></div>
        <div style="text-align:right"><div class="num" style="font-weight:800;font-size:18px">${sarM(next3)}</div><div class="card-sub">next 3 months · ${sarM(next12)} in 12</div></div></div>
        <div class="chart"><canvas id="ch-port-fund"></canvas></div><div class="legend">${legendProjects}</div></div>
    </div>`;

    $('view-portfolio').innerHTML = head + kpis + table + decisionCard + charts1 + integrityBanner();

    // S-curve
    const labels = cf.months.map(E.monthLabel);
    const cum = arr => { let s = 0; return arr.map(v => (s += v)); };
    const lastActual = cf.months.findIndex(mi => mi > now);
    const cumAct = cum(cf.actual).map((v, i) => (cf.months[i] <= now ? v : null));
    const cumFc = cum(cf.forecast).map((v, i) => (cf.months[i] >= now ? v : null));
    const o = baseOptions(c, v => v);
    o.plugins.tooltip.callbacks = { label: ctx => ctx.parsed.y == null ? null : `${ctx.dataset.label}: ${sarM(ctx.parsed.y)}` };
    draw('portS', 'ch-port-s', { type: 'line', data: { labels, datasets: [
      { label: 'Baseline', data: cum(cf.baseline), borderColor: c.base, borderWidth: 2, pointRadius: 0, tension: 0.3 },
      { label: 'Certified', data: cumAct, borderColor: c.actual, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.3 },
      { label: 'Forecast', data: cumFc, borderColor: c.forecast, borderDash: [6, 4], borderWidth: 2, pointRadius: 0, tension: 0.3 }
    ] }, options: o });
    void lastActual;

    const of = baseOptions(c, v => v);
    of.scales.x.stacked = true; of.scales.y.stacked = true;
    of.plugins.tooltip.callbacks = { label: ctx => `${ctx.dataset.label}: ${sarM(ctx.parsed.y)}`, footer: items => `Total: ${sarM(E.sum(items, it => it.parsed.y))}` };
    draw('portFund', 'ch-port-fund', { type: 'bar', data: { labels: fwd.map(x => E.monthLabel(x.mi)), datasets: cf.byProject.map((b, i) => ({
      label: b.name, data: fwd.map(x => b.forecast[x.i]), backgroundColor: c.series[i % c.series.length],
      borderColor: c.surface, borderWidth: 1, borderRadius: 3, borderSkipped: false
    })) }, options: of });

    document.querySelectorAll('[data-open-project]').forEach(tr => {
      const go = () => { state.projectId = tr.dataset.openProject; navigate('project'); };
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
    $('csv-portfolio').addEventListener('click', exportPortfolioCsv);
  }

  function integrityBanner(ids) {
    const list = (ids || state.projects.map(p => p.id)).flatMap(id => state.issues[id].map(i => `${state.byId[id].name}: ${i}`));
    return list.length
      ? `<div class="note warn"><b>Data integrity — ${list.length} item(s) to reconcile:</b><ul style="margin:6px 0 0;padding-left:18px">${list.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`
      : `<div class="note ok"><b>Data integrity:</b> budgets, cash-flow baselines and certified actuals reconcile for ${ids ? 'this project' : 'all projects'}.</div>`;
  }

  function projectSelect(id, value, includePortfolio) {
    return `<select class="select" id="${id}" aria-label="Project">
      ${includePortfolio ? `<option value="portfolio" ${value === 'portfolio' ? 'selected' : ''}>Whole portfolio</option>` : ''}
      ${state.projects.map(p => `<option value="${p.id}" ${p.id === value ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
  }

  function renderProject() {
    const p = state.byId[state.projectId], m = state.m[p.id], mc = state.mc[p.id], r = state.rag[p.id];
    const c = palette();
    const pre = m.ac === 0 && m.pv === 0;
    const head = `<div class="view-head">
      <div><h1>${esc(p.name)} ${ragChip(r.overall)}</h1>
        <p class="lede">${esc(p.sector)} · ${esc(p.stage)} · Sponsor: ${esc(p.sponsor)} · ${esc(p.pm)}${p.feed ? ` · <span class="pill">Linked: ${esc(p.feed.title || p.feed.kind)}</span>` : ''}</p></div>
      <div class="actions no-print">${projectSelect('proj-select', p.id)}<button class="btn" id="csv-project" type="button">Export CSV</button></div></div>`;
    const kpis = `<div class="grid g-kpi">
      ${kpi('Approved budget (BAC)', sarM(p.bac), `<span>${m.duration} month programme</span><span class="muted">from ${E.monthLabel(m.startIdx)}</span>`)}
      ${kpi('Forecast final cost', sarM(m.eac), `<span class="${m.headroom < 0 ? 'delta-bad' : 'delta-good'}">${sarM(m.headroom)} headroom</span>` + (pre ? '' : `<span class="muted">CPI-based ${sarM(m.eacCpi)}</span>`))}
      ${kpi('Risk-adjusted cost', `P80 ${sarM(mc.p80)}`, `<span>P50 ${sarM(mc.p50)}</span><span class="${mc.probWithinBac < 0.8 ? 'delta-bad' : 'delta-good'}">${pct(mc.probWithinBac)} ≤ BAC</span>`)}
      ${kpi('Committed', pct(m.committedPct), `<span>${sarM(m.committed)}</span><span class="muted">${sarM(m.uncommitted)} to let</span>`)}
      ${kpi('Certified to date', sarM(m.certified), `<span>retention ${sarM(m.retention, 2)}</span><span class="muted">net paid ${sarM(m.certified - m.retention)}</span>`)}
      ${kpi('Performance', pre ? 'Not started' : `CPI ${idx(m.cpi)} · SPI ${idx(m.spi)}`, pre ? '<span class="muted">EVM begins at NTP</span>' : `<span>${pct(m.pctComplete)} complete</span><span class="${m.forecastDelay ? 'delta-bad' : 'muted'}">${m.forecastDelay ? `+${m.forecastDelay} mo indicative` : 'on programme'}</span>`)}
    </div>`;

    const cf = E.cashflow(p, m);
    const contBase = Math.max(1e-9, p.contingency.original);
    const contUsedPct = Math.min(1, p.contingency.drawn / contBase);
    const pressPct = Math.max(0, Math.min(1 - contUsedPct, m.overrunPressure / contBase));
    const free = m.contRemaining - m.overrunPressure;
    const sCard = `<div class="card"><div class="card-head"><div><h2>Cash flow S-curve</h2><div class="card-sub">Baseline vs certified vs forecast (forecast spreads EAC over the remaining baseline shape${m.forecastDelay ? `, stretched +${m.forecastDelay} mo` : ''})</div></div>
      <div class="seg no-print" role="group" aria-label="Chart mode"><button type="button" data-mode="cumulative" aria-pressed="${state.chartMode === 'cumulative'}">Cumulative</button><button type="button" data-mode="monthly" aria-pressed="${state.chartMode === 'monthly'}">Monthly</button></div></div>
      ${chartUnavailable()}<div class="chart"><canvas id="ch-proj-s"></canvas></div>
      <div class="legend"><span><i style="background:${c.base}"></i>Baseline</span><span><i style="background:${c.actual}"></i>Certified</span><span><i class="dash" style="color:${c.forecast}"></i>Forecast</span></div></div>`;
    const contCard = `<div class="card"><div class="card-head"><div><h2>Contingency</h2><div class="card-sub">Drawn, forecast to draw, and genuinely free</div></div>${ragChip(free < 0 ? 'R' : free < 0.25 * p.contingency.original ? 'A' : 'G', free < 0 ? 'Exhausted' : free < 0.25 * p.contingency.original ? 'Thin' : 'Adequate')}</div>
      <div class="meter" role="img" aria-label="Contingency usage">
        <span style="width:${(contUsedPct * 100).toFixed(1)}%;background:${c.base}" title="Drawn"></span>
        <span style="width:${(pressPct * 100).toFixed(1)}%;background:${c.forecast}" title="Forecast to draw"></span></div>
      <div class="legend"><span><i class="box" style="background:${c.base}"></i>Drawn</span><span><i class="box" style="background:${c.forecast}"></i>Forecast overruns</span><span><i class="box" style="background:var(--surface-2);border:1px solid var(--border)"></i>Free</span></div>
      <div class="kv">
        <span>Original contingency</span><span class="num">${sarM(p.contingency.original, 2)}</span>
        <span>Drawn (transferred to packages)</span><span class="num">−${sarM(p.contingency.drawn, 2)}</span>
        <span>Package overruns not yet transferred</span><span class="num">−${sarM(m.overrunPressure, 2)}</span>
        <span class="total">Free contingency</span><span class="total num ${free < 0 ? 'delta-bad' : 'delta-good'}">${sarM(free, 2)}</span>
        <span>Unmitigated risk (P80 − forecast)</span><span class="num ${mc.p80 - m.eac > m.headroom ? 'delta-bad' : ''}">${sarM(mc.p80 - m.eac, 2)}</span>
      </div>
      <p class="hint" style="margin:10px 0 0">Free contingency equals headroom to BAC. ${mc.p80 - m.eac > m.headroom ? '<b>It does not cover the P80 risk exposure.</b>' : 'It covers the P80 risk exposure.'}</p></div>`;

    const cbsRows = m.pkgs.map(k => `<tr>
      <td><span class="mono muted">${esc(k.code)}</span> ${esc(k.name)}${k.eacRaised ? ' <span class="pill" title="EAC raised to committed value">EAC↑</span>' : ''}</td>
      <td class="r num">${NF[2].format(k.budget)}</td><td class="r num">${NF[2].format(k.committed)}</td>
      <td class="r num">${NF[2].format(k.certified)}</td><td class="r num">${NF[2].format(k.eac)}</td>
      <td class="r num ${deltaClass(k.variance)}">${k.variance > 0 ? '+' : ''}${NF[2].format(k.variance)}</td>
      <td class="r num">${pct(k.pct)} <span class="muted">/ ${pct(k.planPct)}</span></td>
      <td class="r num">${k.cpi == null ? '—' : idx(k.cpi)}</td><td class="r num">${k.spi == null ? '—' : idx(k.spi)}</td></tr>`).join('');
    const cbs = `<div class="card flush"><div class="card-head"><div><h2>Cost breakdown</h2><div class="card-sub">Current budgets include approved contingency transfers · SAR millions · variance = EAC − budget</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>Package</th><th class="r">Budget</th><th class="r">Committed</th><th class="r">Certified</th><th class="r">EAC</th><th class="r">Variance</th><th class="r">Done / plan</th><th class="r">CPI</th><th class="r">SPI</th></tr></thead>
      <tbody>${cbsRows}</tbody>
      <tfoot><tr><td>Total packages</td><td class="r num">${NF[2].format(m.budget)}</td><td class="r num">${NF[2].format(m.committed)}</td><td class="r num">${NF[2].format(m.certified)}</td><td class="r num">${NF[2].format(m.eac)}</td><td class="r num ${deltaClass(m.eac - m.budget)}">${NF[2].format(m.eac - m.budget)}</td><td class="r num">${pct(m.pctComplete)}</td><td class="r num">${pre ? '—' : idx(m.cpi)}</td><td class="r num">${pre ? '—' : idx(m.spi)}</td></tr></tfoot></table></div></div>`;

    const q = state.search.trim().toLowerCase();
    const cs = p.commitments.filter(x => !q || [x.id, x.title, x.vendor, x.pkg].some(v => String(v).toLowerCase().includes(q)));
    const commitRows = cs.map(x => `<tr>
      <td><span class="mono" style="color:var(--accent);font-weight:700">${esc(x.id)}</span> ${esc(x.title)}</td>
      <td>${esc(x.vendor)}</td><td class="mono">${esc(x.pkg)}</td>
      <td class="r num">${NF[2].format(x.original)}</td><td class="r num">${x.variations ? '+' + NF[2].format(x.variations) : '—'}</td>
      <td class="r num">${NF[2].format(x.certified)}</td><td class="r num">${pct(x.certified / Math.max(1e-9, x.original + x.variations))}</td>
      <td class="c"><span class="pill">${esc(x.status)}</span></td>
      <td class="r"><button class="link" type="button" data-statement="${esc(x.id)}">Statement</button></td></tr>`).join('');
    const commits = `<div class="card flush"><div class="card-head"><div><h2>Contract commitments</h2><div class="card-sub">${p.commitments.length} contracts · SAR millions</div></div>
      <div class="actions no-print"><input class="search" id="commit-search" type="search" placeholder="Search ID, vendor, package" value="${esc(state.search)}" aria-label="Search commitments"><button class="btn btn-primary" type="button" id="commit-add">Record commitment</button></div></div>
      <div class="table-wrap"><table><thead><tr><th>Contract</th><th>Vendor</th><th>Pkg</th><th class="r">Original</th><th class="r">Variations</th><th class="r">Certified</th><th class="r">% cert.</th><th class="c">Status</th><th></th></tr></thead>
      <tbody>${commitRows || `<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">${p.commitments.length ? 'No contracts match the search.' : 'No contracts awarded yet. Awards from the Procurement app can be loaded under Connected apps.'}</td></tr>`}</tbody></table></div></div>`;

    const hasLocal = (store.added?.[p.id] || []).length || store.overrides?.[p.id] || store.feeds?.[p.id];
    $('view-project').innerHTML = head + kpis + `<div class="grid g-2-1">${sCard}${contCard}</div>` + cbs + commits + riskTable([p]) + integrityBanner([p.id]) +
      (hasLocal ? `<div class="no-print"><button class="btn" type="button" id="reset-project">Discard local changes to this project</button></div>` : '');

    // Chart
    const labels = Array.from({ length: cf.len }, (_, i) => E.monthLabel(cf.startIdx + i));
    const cum = state.chartMode === 'cumulative';
    const pick = (arr, cumArr) => (cum ? cumArr : arr);
    const n = cf.elapsed;
    const actual = pick(cf.actual, cf.cumActual);
    const fc = pick(cf.forecast, cf.cumForecast).map((v, i) => (i >= Math.max(0, n - 1) ? v : null));
    if (!cum && n > 0) fc[n - 1] = null;
    const o = baseOptions(c, v => v);
    o.plugins.tooltip.callbacks = { label: ctx => ctx.parsed.y == null ? null : `${ctx.dataset.label}: ${sarM(ctx.parsed.y, 2)}` };
    draw('projS', 'ch-proj-s', { type: 'line', data: { labels, datasets: [
      { label: 'Baseline', data: pick(cf.baseline, cf.cumBaseline), borderColor: c.base, borderWidth: 2, pointRadius: 0, tension: 0.3 },
      { label: 'Certified', data: actual, borderColor: c.actual, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.3 },
      { label: 'Forecast', data: fc, borderColor: c.forecast, borderDash: [6, 4], borderWidth: 2, pointRadius: 0, tension: 0.3 }
    ] }, options: o });

    $('proj-select').addEventListener('change', e => { state.projectId = e.target.value; state.search = ''; renderProject(); });
    $('csv-project').addEventListener('click', () => exportProjectCsv(p));
    document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { state.chartMode = b.dataset.mode; renderProject(); }));
    const s = $('commit-search');
    s.addEventListener('input', () => { state.search = s.value; renderProject(); const ns = $('commit-search'); ns.focus(); ns.setSelectionRange(ns.value.length, ns.value.length); });
    $('commit-add').addEventListener('click', openCommitModal);
    document.querySelectorAll('[data-statement]').forEach(b => b.addEventListener('click', () => openStatement(b.dataset.statement)));
    const rs = $('reset-project');
    if (rs) rs.addEventListener('click', () => {
      // Two-step confirmation in the page (the hosted viewer suppresses confirm()).
      if (rs.dataset.armed !== '1') {
        rs.dataset.armed = '1'; rs.textContent = `Click again to discard local changes to ${p.name}`; rs.classList.add('btn-primary');
        setTimeout(() => { if (rs.isConnected) { rs.dataset.armed = ''; rs.textContent = 'Discard local changes to this project'; rs.classList.remove('btn-primary'); } }, 5000);
        return;
      }
      ['added', 'actualAdds', 'overrides', 'feeds'].forEach(k => { if (store[k]) delete store[k][p.id]; });
      saveStore(); refresh(); toast('Local changes discarded.');
    });
  }

  function riskTable(projects) {
    const rows = projects.flatMap(p => E.riskExposure(p).map(r => ({ ...r, project: p.name })))
      .sort((a, b) => b.expected - a.expected);
    const multi = projects.length > 1;
    return `<div class="card flush"><div class="card-head"><div><h2>Risk register</h2><div class="card-sub">Unmitigated, excluded from EAC · ranked by expected value (probability × mean impact) · SAR millions</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>Risk</th>${multi ? '<th>Project</th>' : ''}<th>Owner</th><th class="r">Prob.</th><th class="r">Impact (min / likely / max)</th><th class="r">Expected</th><th class="r">Delay</th><th>Mitigation</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td><span class="mono muted">${esc(r.id)}</span> ${esc(r.title)}</td>${multi ? `<td>${esc(r.project)}</td>` : ''}<td>${esc(r.owner)}</td>
        <td class="r num">${pct(r.p)}</td><td class="r num">${NF[1].format(r.min)} / ${NF[1].format(r.ml)} / ${NF[1].format(r.max)}</td>
        <td class="r num" style="font-weight:700">${NF[2].format(r.expected)}</td><td class="r num">${r.delayWeeks ? r.delayWeeks + ' wk' : '—'}</td><td class="ink2" style="font-size:12px">${esc(r.mitigation)}</td></tr>`).join('') ||
        '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">No risks registered.</td></tr>'}</tbody></table></div></div>`;
  }

  function scenarioRun() {
    const s = state.scenario;
    const scope = state.riskScope;
    const projects = scope === 'portfolio' ? state.projects : [state.byId[scope]];
    const runs = projects.map(p => E.monteCarlo(p, state.m[p.id], s));
    const bac = E.sum(projects, p => p.bac);
    const eac = E.sum(projects, p => state.m[p.id].eac);
    const mc = runs.length === 1 ? runs[0] : E.portfolioMonteCarlo(runs, bac);
    const det = E.sum(projects, p => E.scenarioCost(p, state.m[p.id], s).total);
    const fin = E.sum(projects, p => E.scenarioCost(p, state.m[p.id], s).financing);
    return { projects, mc, bac, eac, det, fin };
  }

  function renderRisk() {
    const s = state.scenario;
    const T = E.THRESHOLDS;
    $('view-risk').innerHTML = `<div class="view-head">
        <div><h1>Risk &amp; scenarios</h1><p class="lede">Monte Carlo of final cost (5,000 iterations, fixed seed so figures are reproducible between board meetings). Sliders stress the forecast; the risk register drives the spread.</p></div>
        <div class="actions no-print">${projectSelect('risk-scope', state.riskScope, true)}</div></div>
      <div class="grid g-3 no-print">
        <div class="slider"><div class="slider-top"><label for="sl-delay">Schedule slippage</label><span class="num" id="sl-delay-v"></span></div>
          <input type="range" id="sl-delay" min="0" max="12" step="1" value="${s.delayMonths}"><p>Adds time-related preliminaries and financing carry for each month.</p></div>
        <div class="slider"><div class="slider-top"><label for="sl-esc">Escalation on uncommitted scope</label><span class="num" id="sl-esc-v"></span></div>
          <input type="range" id="sl-esc" min="0" max="20" step="0.5" value="${s.escalationPct}"><p>Applied only to forecast value not yet under contract.</p></div>
        <div class="slider"><div class="slider-top"><label for="sl-apr">Debt financing rate</label><span class="num" id="sl-apr-v"></span></div>
          <input type="range" id="sl-apr" min="3" max="12" step="0.25" value="${s.aprPct}"><p>Interest during construction on the debt share, for the delay period.</p></div>
      </div>
      <div class="grid g-kpi" id="risk-kpis"></div>
      <div class="card"><div class="card-head"><div><h2>Distribution of final cost</h2><div class="card-sub" id="risk-hist-sub"></div></div>
        <button class="btn no-print" type="button" id="risk-reset">Reset scenario</button></div>
        ${chartUnavailable()}<div class="chart sm"><canvas id="ch-hist"></canvas></div>
        <div class="legend" id="risk-legend"></div></div>
      <div id="risk-register"></div>
      <div class="card"><details class="method" open><summary>Method, thresholds &amp; assumptions</summary><ul>
        <li><b>Forecast (EAC)</b> is bottom-up per package and never below committed value. <b>Headroom</b> = BAC − EAC, which equals free contingency.</li>
        <li><b>EVM:</b> EV = Σ budget × physical % complete; PV = Σ budget × planned %; AC = gross certified. Performance-based EAC = AC + (Σ budget − EV) / CPI is shown as an independent check.</li>
        <li><b>Monte Carlo:</b> remaining cost per package × triangular(0.97, 1.00, 1.03 + 0.12 × uncommitted share); each register risk fires with its probability and a triangular impact; risk delays take the longest that fired (not summed). Projects are treated as independent, which understates portfolio tail risk if risks are correlated.</li>
        <li><b>Financing</b> = cost × debt share × rate × delay months / 12. A simplification, not a drawdown-weighted IDC model.</li>
        <li><b>Indicative finish</b> = planned duration / SPI. Early in a project this overstates delay; use the planner's CPM dates for commitments to the board.</li>
        <li><b>RAG:</b> Cost red if headroom &lt; 0, P(≤BAC) &lt; ${pct(T.confidenceRed)} or CPI &lt; ${T.cpiRed}; amber if P(≤BAC) &lt; ${pct(T.confidenceGreen)} or CPI &lt; ${T.cpiAmber}. Schedule red if SPI &lt; ${T.spiRed}; amber if SPI &lt; ${T.spiAmber}. Overall = worse of the two. RAG always uses the unstressed scenario.</li>
        <li>Project data in this build is illustrative except Crystal Gallery, which is priced from the shared cost-model feed.</li>
      </ul></details></div>`;

    const update = () => {
      s.delayMonths = Number($('sl-delay').value); s.escalationPct = Number($('sl-esc').value); s.aprPct = Number($('sl-apr').value);
      $('sl-delay-v').textContent = `+${s.delayMonths} mo`; $('sl-esc-v').textContent = `+${s.escalationPct.toFixed(1)}%`; $('sl-apr-v').textContent = `${s.aprPct.toFixed(2)}%`;
      const r = scenarioRun();
      const contNeedP80 = r.mc.p80 - r.eac;
      const headroom = r.bac - r.eac;
      $('risk-kpis').innerHTML =
        kpi('Stressed forecast (no risk events)', sarM(r.det), `<span class="${deltaClass(r.det - r.bac)}">${signedM(r.det - r.bac)} vs BAC</span><span class="muted">financing ${sarM(r.fin, 2)}</span>`) +
        kpi('P50 / P80 / P90', `${NF[1].format(r.mc.p50)} / ${NF[1].format(r.mc.p80)}`, `<span>P90 ${sarM(r.mc.p90)}</span><span class="muted">SAR millions</span>`) +
        kpi('Confidence within BAC', pct(r.mc.probWithinBac), `<span>BAC ${sarM(r.bac)}</span>`, r.mc.probWithinBac < T.confidenceRed ? 'delta-bad' : r.mc.probWithinBac < T.confidenceGreen ? 'delta-warn' : 'delta-good') +
        kpi('Contingency adequacy at P80', signedM(headroom - contNeedP80), `<span>needs ${sarM(contNeedP80)}</span><span class="muted">has ${sarM(headroom)}</span>`, headroom - contNeedP80 < 0 ? 'delta-bad' : 'delta-good');
      const h = E.histogram(r.mc.sorted, 28);
      const c = palette();
      const centers = h.edges.map(e => e + h.width / 2);
      $('risk-hist-sub').textContent = `${r.mc.iterations.toLocaleString('en-US')} simulated outcomes · ${r.projects.length === 1 ? r.projects[0].name : 'whole portfolio'} · SAR millions`;
      $('risk-legend').innerHTML = `<span><i class="box" style="background:${c.actual}"></i>Outcomes within BAC</span><span><i class="box" style="background:${c.forecast}"></i>Outcomes over BAC</span><span><i style="background:${c.ink}"></i>BAC</span><span><i class="dash" style="color:${c.muted}"></i>P50 · P80 · P90</span>`;
      const markers = [
        { v: r.bac, label: 'BAC', color: c.ink, dash: [] },
        { v: r.mc.p50, label: 'P50', color: c.muted, dash: [4, 3] },
        { v: r.mc.p80, label: 'P80', color: c.muted, dash: [4, 3] },
        { v: r.mc.p90, label: 'P90', color: c.muted, dash: [4, 3] }
      ];
      const markerPlugin = {
        id: 'markers',
        afterDatasetsDraw(chart) {
          const x = chart.scales.x, area = chart.chartArea, ctx = chart.ctx;
          if (x.ticks.length < 2) return;
          const p0 = x.getPixelForValue(0), p1 = x.getPixelForValue(1);
          ctx.save();
          ctx.font = '600 11px "JetBrains Mono", monospace';
          markers.forEach((mk, i) => {
            const f = (mk.v - h.lo) / h.width - 0.5;
            const px = p0 + f * (p1 - p0);
            if (px < area.left - 1 || px > area.right + 1) return;
            ctx.strokeStyle = mk.color; ctx.fillStyle = mk.color; ctx.lineWidth = 1.5; ctx.setLineDash(mk.dash);
            ctx.beginPath(); ctx.moveTo(px, area.top - 4); ctx.lineTo(px, area.bottom); ctx.stroke();
            ctx.setLineDash([]);
            ctx.textAlign = px > area.right - 40 ? 'right' : 'left';
            ctx.fillText(mk.label, px + (ctx.textAlign === 'left' ? 4 : -4), area.top - 20 + (i % 2) * 12);
          });
          ctx.restore();
        }
      };
      const o = baseOptions(c, v => `${v}%`);
      o.interaction = { mode: 'nearest', intersect: false, axis: 'x' };
      o.layout = { padding: { top: 30 } };
      o.scales.x.ticks.callback = function (v, i) { return i % 4 === 0 ? NF[0].format(centers[i]) : ''; };
      o.plugins.tooltip.callbacks = {
        title: items => `SAR ${NF[1].format(h.edges[items[0].dataIndex])}–${NF[1].format(h.edges[items[0].dataIndex] + h.width)}M`,
        label: ctx => `${ctx.parsed.y.toFixed(1)}% of outcomes`
      };
      draw('hist', 'ch-hist', { type: 'bar', data: { labels: centers.map(v => v.toFixed(1)), datasets: [{
        label: 'Share of outcomes', data: h.share.map(v => v * 100),
        backgroundColor: centers.map(v => (v <= r.bac ? c.actual : c.forecast)),
        borderColor: c.surface, borderWidth: 1, borderRadius: 3, barPercentage: 1, categoryPercentage: 1
      }] }, options: o, plugins: [markerPlugin] });
      $('risk-register').innerHTML = riskTable(r.projects);
    };
    let pending = false;
    const schedule = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; update(); }); };
    ['sl-delay', 'sl-esc', 'sl-apr'].forEach(id => $(id).addEventListener('input', schedule));
    $('risk-scope').addEventListener('change', e => { state.riskScope = e.target.value; update(); });
    $('risk-reset').addEventListener('click', () => {
      Object.assign(state.scenario, E.DEFAULT_SCENARIO);
      $('sl-delay').value = s.delayMonths; $('sl-esc').value = s.escalationPct; $('sl-apr').value = s.aprPct;
      update(); toast('Scenario reset to baseline.');
    });
    update();
  }

  function renderApps() {
    const D = window.MIDAD_DATA;
    const urls = store.appUrls || {};
    const cg = state.projects.find(p => p.feed && p.feed.kind === 'cost-model');
    const cards = D.apps.map(a => {
      const url = urls[a.id] ?? a.url;
      const safe = /^https:\/\//i.test(url) ? url : '';
      return `<div class="card"><div class="card-head"><div><h2>${esc(a.name)}</h2><div class="card-sub">${esc(a.role)}</div></div><span class="pill">${esc(a.mode)}</span></div>
        <p class="ink2" style="margin:0 0 10px;font-size:13px">${esc(a.feeds)}</p>
        <div class="hint">Branch <span class="mono">${esc(a.branch)}</span></div>
        <div class="actions no-print" style="margin-top:12px;flex-wrap:wrap">
          ${safe ? `<a class="btn btn-primary" href="${esc(safe)}" target="_blank" rel="noopener">Open app ↗</a>` : '<span class="pill">No URL set</span>'}
          <input class="search" style="flex:1;min-width:180px" type="url" placeholder="https://… (where this app is hosted)" value="${esc(url)}" data-app-url="${esc(a.id)}" aria-label="${esc(a.name)} URL">
        </div></div>`;
    }).join('');
    const feedCard = cg ? `<div class="card"><div class="card-head"><div><h2>Live link: Crystal Gallery cost model</h2><div class="card-sub">The IPC System reads the same generated file, so the two apps cannot price the project differently</div></div>${ragChip('G', 'Linked')}</div>
      <div class="kv">
        <span>Source</span><span class="mono">${esc(cg.feed.ref)} @ ${esc(String(cg.feed.commit).slice(0, 7))}</span>
        <span>Priced lines</span><span class="num">${cg.feed.lines}</span>
        <span>Base cost (rate base date)</span><span class="num">${sarM(cg.feed.base, 2)}</span>
        <span>Out-turn priced bill = contract sum</span><span class="num">${sarM(cg.feed.outturn, 2)}</span>
        <span>Contingency reserve</span><span class="num">${sarM(cg.feed.contingency, 2)}</span>
        <span class="total">Budget basis (BAC)</span><span class="total num">${sarM(cg.bac, 2)}</span>
        <span>Scope gaps excluded from BAC (expected value)</span><span class="num delta-bad">${sarM(E.sum(E.riskExposure(cg), r => r.expected), 2)}</span>
      </div>
      ${cg.feed.planner ? `<p class="hint">Baseline phasing replaced by a 4D Planner export (${cg.feed.planner.months} months from ${esc(cg.feed.planner.start)}, scaled ×${cg.feed.planner.factor.toFixed(3)} to BAC).</p>` : '<p class="hint">Phasing: each priced line spread linearly over its planned working days (same method as the planner).</p>'}
      <p class="hint">To refresh after the cost model changes: run <span class="mono">tools/sync_costing.py</span> in the IPC System branch, then copy <span class="mono">assets/js/crystal-gallery-costing.js</span> to <span class="mono">assets/feeds/</span> here.</p></div>` : '';

    $('view-apps').innerHTML = `<div class="view-head"><div><h1>Connected apps</h1>
        <p class="lede">The executive suite sits on top of the operational apps. Each owns its data; this page shows what flows up and how.</p></div></div>
      <div class="note warn"><b>No live sync between apps.</b> Three apps keep their data in each viewer's browser or the page's own store, and the procurement app is a separate server with no export API. Links below are either a shared generated file (cost model) or a file you export from one app and import here.</div>
      <div class="card"><h2 style="margin-bottom:10px">Data flow</h2>
        <div class="flow mono" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px">
          <span class="pill">Take-off &amp; BoQ</span><span>→ priced bill →</span><span class="pill">4D Planner</span><span>→ cost-loaded schedule →</span><span class="pill">IPC System</span><span>→ certified to date →</span><span class="pill" style="background:var(--accent-soft);color:var(--ink)">Executive Suite</span>
          <span style="flex-basis:100%;height:0"></span>
          <span class="pill">Procurement</span><span>→ awards →</span><span class="pill" style="background:var(--accent-soft);color:var(--ink)">Executive Suite</span></div></div>
      ${feedCard}
      <div class="grid g-1-1">${cards}</div>
      <div class="grid g-1-1 no-print">
        <div class="card"><h2>Import 4D Planner cash flow</h2>
          <p class="hint">In the planner: Data → <b>Monthly cash flow (.csv)</b>. The baseline column becomes this project's cash plan, rescaled to its BAC.</p>
          <div class="form-grid" style="margin-top:10px"><div class="field"><label for="imp-plan-proj">Apply to</label>${projectSelect('imp-plan-proj', cg ? cg.id : state.projectId)}</div>
            <div class="field"><label for="imp-plan-file">CSV file</label><input type="file" id="imp-plan-file" accept=".csv,text/csv"></div></div>
          <div class="error" id="imp-plan-err" role="alert"></div></div>
        <div class="card"><h2>Import project feed (midad-feed/1)</h2>
          <p class="hint">A JSON file with <span class="mono">{"schema":"midad-feed/1","project":{…}}</span>. Use it to bring in certified totals from the IPC System or awards from Procurement. Same project id replaces; new id adds.</p>
          <div class="form-grid" style="margin-top:10px"><div class="field full"><label for="imp-feed-file">JSON file</label><input type="file" id="imp-feed-file" accept=".json,application/json"></div></div>
          <div class="actions" style="margin-top:10px"><button class="btn" type="button" id="feed-template">Download template from current project</button></div>
          <div class="error" id="imp-feed-err" role="alert"></div></div>
      </div>`;

    document.querySelectorAll('[data-app-url]').forEach(inp => inp.addEventListener('change', () => {
      const v = inp.value.trim();
      if (v && !/^https:\/\//i.test(v)) { toast('Use an https:// address.'); return; }
      store.appUrls = { ...(store.appUrls || {}), [inp.dataset.appUrl]: v }; saveStore(); renderApps(); toast('App link saved in this browser.');
    }));
    $('imp-plan-file').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      const err = $('imp-plan-err'); err.textContent = '';
      try {
        const parsed = A.parsePlannerCashflow(await f.text());
        const pid = $('imp-plan-proj').value, p = state.byId[pid];
        const res = A.applyPlannerCashflow(p, parsed);
        if (parsed.currency && parsed.currency.toUpperCase() !== 'SAR') throw new Error(`Export is in ${parsed.currency}; set the planner currency to SAR first`);
        if (p.monthlyActual.length && parsed.start !== p.start) throw new Error(`Planner starts ${parsed.start} but ${p.name} has actuals from ${p.start}; re-baseline in the planner first`);
        store.overrides = { ...(store.overrides || {}), [pid]: { start: res.project.start, monthlyBaseline: res.project.monthlyBaseline, feed: res.project.feed } };
        saveStore(); refresh();
        toast(`Planner baseline applied to ${p.name} (${parsed.months} months, planner total ${sarM(res.plannerTotal)}).`);
      } catch (ex) { err.textContent = ex.message; }
      e.target.value = '';
    });
    $('imp-feed-file').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      const err = $('imp-feed-err'); err.textContent = '';
      try {
        const p = A.parseFeed(await f.text());
        const issues = E.integrityChecks(p, E.projectMetrics(p));
        store.feeds = { ...(store.feeds || {}), [p.id]: p };
        saveStore(); refresh();
        toast(`Feed loaded: ${p.name}${issues.length ? ` — ${issues.length} integrity item(s) flagged` : ''}.`);
      } catch (ex) { err.textContent = ex.message; }
      e.target.value = '';
    });
    $('feed-template').addEventListener('click', () => {
      const p = state.byId[state.projectId];
      download(`midad-feed_${p.code}.json`, JSON.stringify({ schema: 'midad-feed/1', exportedAt: new Date().toISOString(), project: p }, null, 2), 'application/json');
    });
  }

  function narrative(p) {
    const m = state.m[p.id], mc = state.mc[p.id], r = state.rag[p.id];
    const pre = m.ac === 0 && m.pv === 0;
    const parts = [];
    parts.push(`${p.name} is <b>${RAG_WORD[r.overall].toLowerCase()}</b> (cost ${RAG_WORD[r.cost].toLowerCase()}, schedule ${RAG_WORD[r.schedule].toLowerCase()}).`);
    parts.push(`Forecast final cost is ${sarM(m.eac)} against a budget of ${sarM(p.bac)}, leaving ${sarM(m.headroom)} of headroom; there is a ${pct(mc.probWithinBac)} chance of finishing within budget (P80 ${sarM(mc.p80)}).`);
    if (pre) parts.push(`The project is at stage “${esc(p.stage)}”; no cost has been certified and nothing is yet under contract.`);
    else parts.push(`Work is ${pct(m.pctComplete)} complete with CPI ${idx(m.cpi)} and SPI ${idx(m.spi)}${m.forecastDelay ? `, indicating roughly ${m.forecastDelay} month(s) of delay` : ''}. ${pct(m.committedPct)} of the budget is committed.`);
    const top = E.riskExposure(p)[0];
    if (top) parts.push(`Largest risk: ${esc(top.title)} (expected ${sarM(top.expected, 2)}).`);
    return parts.join(' ');
  }

  function renderReport() {
    const P = state.portfolio;
    const period = E.monthLabel(E.monthIndex(window.MIDAD_DATA.reportingPeriod));
    const reds = state.projects.filter(p => state.rag[p.id].overall === 'R');
    $('view-report').innerHTML = `<div class="report card">
      <div class="view-head"><div><div class="brand-sub">Board report · period ${period}</div><h1 style="margin-top:6px">Capital portfolio — executive summary</h1></div>
        <div class="actions no-print"><button class="btn" type="button" id="rep-csv">Export CSV</button>${HOSTED ? '' : '<button class="btn btn-primary" type="button" id="rep-print">Print / save PDF</button>'}</div></div>
      <section><h2>Headline</h2>
        <p>The portfolio of ${state.projects.length} projects carries an approved budget of <b>${sarM(P.bac)}</b>. Bottom-up forecasts total <b>${sarM(P.eac)}</b> (${signedM(P.eac - P.bac)} against budget). On a risk-adjusted basis the portfolio has a <b>${pct(P.mc.probWithinBac)}</b> chance of completing within budget; the P80 outcome is ${sarM(P.mc.p80)}.</p>
        <p>${reds.length ? `<b>${reds.length} project(s) are off track:</b> ${reds.map(p => esc(p.name)).join(', ')}.` : 'No project is off track.'} ${pct(P.committed / P.bac)} of budget is committed and ${sarM(P.certified)} has been certified to date.</p></section>
      <section><h2>Project status</h2><div class="table-wrap"><table><thead><tr><th>Project</th><th class="r">BAC</th><th class="r">Forecast</th><th class="r">P(≤BAC)</th><th class="c">Cost</th><th class="c">Schedule</th><th class="c">Overall</th></tr></thead><tbody>
        ${state.projects.map(p => { const r = state.rag[p.id]; return `<tr><td>${esc(p.name)}</td><td class="r num">${sarM(p.bac)}</td><td class="r num">${sarM(state.m[p.id].eac)}</td><td class="r num">${pct(state.mc[p.id].probWithinBac)}</td><td class="c">${ragChip(r.cost)}</td><td class="c">${ragChip(r.schedule)}</td><td class="c">${ragChip(r.overall)}</td></tr>`; }).join('')}
      </tbody></table></div></section>
      <section><h2>Decisions requested of the board</h2><ol style="padding-left:18px">
        ${P.exceptions.filter(e => e.sev === 'R').map(e => `<li style="margin:6px 0"><b>${esc(e.project)}:</b> ${esc(e.title)}. <i>${esc(e.ask)}.</i></li>`).join('') || '<li>None at urgent level.</li>'}
      </ol>${P.exceptions.some(e => e.sev === 'A') ? `<p class="hint">${P.exceptions.filter(e => e.sev === 'A').length} further items for management review are listed on the Portfolio page.</p>` : ''}</section>
      <section><h2>Project commentary</h2>${state.projects.map(p => `<div class="proj"><h3>${esc(p.name)} ${ragChip(state.rag[p.id].overall)}</h3><p>${narrative(p)}</p></div>`).join('')}</section>
      <section><p class="hint">${HOSTED ? 'To print, open the app locally (see README). ' : ''}Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} by Midad Executive Suite from the cost ledger. Risk figures from a seeded 5,000-iteration Monte Carlo; method on the Risk &amp; scenarios page. Project data is illustrative except where marked as linked.</p></section>
    </div>`;
    if (!HOSTED) $('rep-print').addEventListener('click', () => window.print());
    $('rep-csv').addEventListener('click', exportPortfolioCsv);
  }

  /* ---------------- Exports ---------------- */
  function exportPortfolioCsv() {
    const head = ['project', 'stage', 'bac_sar_m', 'eac_sar_m', 'headroom_sar_m', 'committed_sar_m', 'certified_sar_m', 'cpi', 'spi', 'p50_sar_m', 'p80_sar_m', 'p_within_bac', 'rag_cost', 'rag_schedule', 'rag_overall'];
    const rows = state.projects.map(p => {
      const m = state.m[p.id], mc = state.mc[p.id], r = state.rag[p.id];
      return [p.name, p.stage, p.bac, m.eac, m.headroom, m.committed, m.certified, m.cpi, m.spi, mc.p50, mc.p80, mc.probWithinBac, r.cost, r.schedule, r.overall]
        .map(v => (typeof v === 'number' ? E.round(v, 3) : v));
    });
    download(`midad_portfolio_${window.MIDAD_DATA.reportingPeriod}.csv`, [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv')
      .then(ok => { if (ok) toast('Portfolio summary exported.'); });
  }
  function exportProjectCsv(p) {
    const m = state.m[p.id];
    const head = ['package_code', 'package', 'budget_sar_m', 'committed_sar_m', 'certified_sar_m', 'eac_sar_m', 'variance_sar_m', 'pct_complete', 'pct_planned', 'cpi', 'spi'];
    const rows = m.pkgs.map(k => [k.code, k.name, k.budget, k.committed, k.certified, k.eac, k.variance, k.pct, k.planPct, k.cpi ?? '', k.spi ?? ''].map(v => (typeof v === 'number' ? E.round(v, 3) : v)));
    download(`midad_${p.code}_cbs_${window.MIDAD_DATA.reportingPeriod}.csv`, [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv')
      .then(ok => { if (ok) toast(`${p.name} cost breakdown exported.`); });
  }

  /* ---------------- Modals ---------------- */
  let lastFocus = null;
  function openModal(id) { lastFocus = document.activeElement; $(id).classList.remove('hidden'); const f = $(id).querySelector('input,select,button'); if (f) f.focus(); }
  function closeModal(id) { $(id).classList.add('hidden'); document.body.classList.remove('print-modal'); if (lastFocus) lastFocus.focus(); }
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal:not(.hidden)').forEach(m => closeModal(m.id)); });

  function openCommitModal() {
    const p = state.byId[state.projectId];
    $('commit-form').reset();
    $('commit-sub').textContent = p.name;
    $('f-pkg').innerHTML = p.packages.map(k => `<option value="${esc(k.code)}">${esc(k.code)} — ${esc(k.name)}</option>`).join('');
    $('f-error').textContent = '';
    updateImpact();
    openModal('commit-modal');
  }
  function updateImpact() {
    const p = state.byId[state.projectId];
    const m = state.m[p.id];
    const k = m.pkgs.find(x => x.code === $('f-pkg').value);
    const val = (Number($('f-value').value) || 0) / 1e6;
    if (!k) { $('f-impact').textContent = ''; return; }
    const after = k.committed + val;
    $('f-impact').innerHTML = `Package ${esc(k.code)}: committed ${sarM(k.committed, 2)} → <b>${sarM(after, 2)}</b> of ${sarM(k.budget, 2)} budget.` +
      (after > k.eac ? ` <span class="delta-bad">EAC will rise to ${sarM(after, 2)}.</span>` : '') +
      ' Certified amounts are booked to the current period.';
  }
  ['f-pkg', 'f-value'].forEach(id => $(id).addEventListener('input', updateImpact));
  $('commit-form').addEventListener('submit', e => {
    e.preventDefault();
    const p = state.byId[state.projectId];
    const title = $('f-title').value.trim(), vendor = $('f-vendor').value.trim();
    const value = Number($('f-value').value), cert = Number($('f-cert').value || 0);
    const err = $('f-error');
    if (!title || !vendor) { err.textContent = 'Title and vendor are required.'; return; }
    if (!(value > 0)) { err.textContent = 'Contract value must be greater than zero.'; return; }
    if (cert < 0 || cert > value) { err.textContent = 'Certified to date must be between 0 and the contract value.'; return; }
    const prefix = (p.commitments[0]?.id.split('-')[0]) || p.code;
    const nums = p.commitments.map(c => Number(c.id.split('-')[1]) || 0);
    const id = `${prefix}-${(nums.length ? Math.max(...nums) : (Number(p.id.replace(/\D/g, '')) || 9) * 100) + 1}`;
    const c = { id, title, vendor, pkg: $('f-pkg').value, original: value / 1e6, variations: 0, certified: cert / 1e6, status: $('f-status').value };
    store.added = { ...(store.added || {}), [p.id]: [...(store.added?.[p.id] || []), c] };
    if (cert > 0) store.actualAdds = { ...(store.actualAdds || {}), [p.id]: (store.actualAdds?.[p.id] || 0) + cert / 1e6 };
    saveStore();
    closeModal('commit-modal');
    refresh();
    toast(`${id} recorded against ${p.name}.`);
  });

  function openStatement(cid) {
    const p = state.byId[state.projectId];
    const c = p.commitments.find(x => x.id === cid); if (!c) return;
    const rr = window.MIDAD_DATA.retentionRate;
    const revised = c.original + c.variations;
    const ret = c.certified * rr;
    $('statement-title').textContent = `Commitment statement — ${c.id}`;
    $('statement-body').innerHTML = `
      <div style="font-weight:700">${esc(c.title)}</div>
      <div class="muted" style="font-size:12px">${esc(c.vendor)} · ${esc(p.name)} · package ${esc(c.pkg)} · status ${esc(c.status)}</div>
      <div class="kv">
        <span>Original contract value</span><span class="num">${sar(c.original)}</span>
        <span>Approved variations</span><span class="num">${sar(c.variations)}</span>
        <span class="total">Revised contract value</span><span class="total num">${sar(revised)}</span>
        <span>Gross certified to date</span><span class="num">${sar(c.certified)}</span>
        <span>Retention held (${pct(rr)})</span><span class="num">−${sar(ret)}</span>
        <span class="total">Net paid to date</span><span class="total num">${sar(c.certified - ret)}</span>
        <span>Remaining to certify</span><span class="num">${sar(revised - c.certified)}</span>
      </div>
      <p class="note" style="margin-top:14px">Ledger summary for management information. It is <b>not</b> an Interim Payment Certificate; certificates are issued from the ASCTO IPC System.</p>`;
    openModal('statement-modal');
  }
  $('statement-print').addEventListener('click', () => { document.body.classList.add('print-modal'); window.print(); document.body.classList.remove('print-modal'); });

  /* ---------------- Navigation & theme ---------------- */
  const RENDER = { portfolio: renderPortfolio, project: renderProject, risk: renderRisk, apps: renderApps, report: renderReport };
  function navigate(view) {
    state.view = view;
    document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === view)));
    Object.keys(RENDER).forEach(v => $(`view-${v}`).classList.toggle('hidden', v !== view));
    RENDER[view]();
    try { history.replaceState(null, '', `#${view}`); } catch (e) { /* sandboxed */ }
    window.scrollTo({ top: 0 });
  }
  function refresh() { buildProjects(); compute(); RENDER[state.view](); }

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => navigate(t.dataset.view)));
  $('boardpack-btn').addEventListener('click', () => { navigate('report'); if (!HOSTED) setTimeout(() => window.print(), 150); });
  if (HOSTED) $('statement-print').hidden = true;
  $('theme-btn').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.getAttribute('data-theme') ? root.getAttribute('data-theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
    RENDER[state.view]();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!document.documentElement.getAttribute('data-theme')) RENDER[state.view](); });

  $('period-label').textContent = `Period ${E.monthLabel(E.monthIndex(window.MIDAD_DATA.reportingPeriod))}`;
  buildProjects();
  compute();
  const initial = (location.hash || '').slice(1);
  navigate(RENDER[initial] ? initial : 'portfolio');
})();
