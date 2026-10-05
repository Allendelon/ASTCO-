/*
 * Midad Executive Suite — calculation engine.
 * Pure functions, no DOM. Loaded in the browser as window.MidadEngine and in
 * Node (tests) via require(). All money values are SAR millions.
 */
(function (root) {
  const EPS = 1e-9;
  const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);
  const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

  /* ---------- Deterministic random numbers (reproducible board figures) ---------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Inverse-CDF sample of a triangular(min, mode, max) distribution.
  function triangular(u, a, m, b) {
    if (b - a < EPS) return m;
    const fc = (m - a) / (b - a);
    return u < fc
      ? a + Math.sqrt(u * (b - a) * (m - a))
      : b - Math.sqrt((1 - u) * (b - a) * (b - m));
  }

  function percentile(sorted, q) {
    if (!sorted.length) return 0;
    const idx = (sorted.length - 1) * q;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  /* ---------- Calendar ---------- */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function monthIndex(ym) { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); }
  function monthKey(idx) { return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`; }
  function monthLabel(idx) { return `${MONTHS[idx % 12]}-${String(Math.floor(idx / 12)).slice(2)}`; }

  /* ---------- Project roll-up ---------- */
  function packageRollup(p) {
    return p.packages.map(pk => {
      const cs = p.commitments.filter(c => c.pkg === pk.code);
      const committed = sum(cs, c => c.original + c.variations);
      const certified = sum(cs, c => c.certified);
      // A forecast can never sit below what is already contractually committed.
      const eac = Math.max(pk.eac, committed);
      const ev = pk.budget * pk.pct;
      const pv = pk.budget * pk.planPct;
      return {
        ...pk, eac, eacRaised: eac > pk.eac + EPS, committed, certified,
        uncommitted: Math.max(0, eac - committed),
        variance: eac - pk.budget,
        ev, pv, ac: certified,
        cpi: certified > EPS ? ev / certified : null,
        spi: pv > EPS ? ev / pv : null
      };
    });
  }

  function projectMetrics(p, opts = {}) {
    const pkgs = packageRollup(p);
    const budget = sum(pkgs, k => k.budget);
    const eac = sum(pkgs, k => k.eac);
    const committed = sum(pkgs, k => k.committed);
    const certified = sum(pkgs, k => k.certified);
    const uncommitted = sum(pkgs, k => k.uncommitted);
    const ev = sum(pkgs, k => k.ev), pv = sum(pkgs, k => k.pv), ac = certified;
    const cpi = ac > EPS ? ev / ac : 1;
    const spi = pv > EPS ? ev / pv : 1;
    const contRemaining = p.contingency.original - p.contingency.drawn;
    const overrunPressure = sum(pkgs, k => Math.max(0, k.variance));
    const headroom = p.bac - eac; // what is left of BAC after the bottom-up forecast
    const retention = certified * (opts.retentionRate ?? 0.05);
    const duration = p.monthlyBaseline.length;
    const elapsed = p.monthlyActual.length;
    // Independent, performance-based EAC (PMI): AC + (BAC_pmb − EV) / CPI.
    const eacCpi = ac + (budget - ev) / (cpi || 1);
    // Indicative schedule forecast: planned duration / SPI (crude early-stage estimate).
    const forecastDelay = spi < 1 ? Math.max(0, Math.round(duration / spi - duration)) : 0;
    return {
      pkgs, budget, eac, committed, certified, uncommitted, ev, pv, ac, cpi, spi,
      cv: ev - ac, sv: ev - pv, tcpi: (budget - ev) / Math.max(EPS, budget - ac),
      contRemaining, overrunPressure, headroom, retention, eacCpi,
      duration, elapsed, forecastDelay,
      startIdx: monthIndex(p.start),
      committedPct: committed / p.bac,
      pctComplete: budget > EPS ? ev / budget : 0
    };
  }

  /* ---------- Cash flow ---------- */
  // Spreads the remaining forecast over the remaining baseline shape, stretched by delay.
  function cashflow(p, m, extraDelay = 0, totalOverride) {
    const base = p.monthlyBaseline.slice();
    const act = p.monthlyActual.slice();
    const n = act.length, L = base.length;
    const delay = m.forecastDelay + extraDelay;
    const remainingLen = Math.max(1, L - n + delay);
    const tail = base.slice(n);
    const weights = [];
    for (let j = 0; j < remainingLen; j++) {
      const srcIdx = tail.length ? Math.min(tail.length - 1, Math.floor((j * tail.length) / remainingLen)) : 0;
      weights.push(tail.length ? tail[srcIdx] : 1);
    }
    const wSum = sum(weights) || 1;
    const total = totalOverride ?? m.eac;
    const remaining = Math.max(0, total - sum(act));
    const forecast = act.concat(weights.map(w => (w / wSum) * remaining));
    const len = Math.max(L, forecast.length);
    const cum = arr => { let s = 0; return arr.map(v => (s += v)); };
    return {
      startIdx: m.startIdx, len, elapsed: n,
      baseline: base, actual: act, forecast,
      cumBaseline: cum(base), cumActual: cum(act), cumForecast: cum(forecast)
    };
  }

  function portfolioCashflow(projects, metricsById) {
    const flows = projects.map(p => ({ p, cf: cashflow(p, metricsById[p.id]) }));
    const start = Math.min(...flows.map(f => f.cf.startIdx));
    const end = Math.max(...flows.map(f => f.cf.startIdx + f.cf.len));
    const months = [];
    for (let i = start; i < end; i++) months.push(i);
    const pick = (arr, f) => months.map(mi => {
      const k = mi - f.cf.startIdx; return k >= 0 && k < arr.length ? arr[k] : 0;
    });
    const byProject = flows.map(f => ({ id: f.p.id, name: f.p.name, baseline: pick(f.cf.baseline, f), actual: pick(f.cf.actual, f), forecast: pick(f.cf.forecast, f) }));
    const tot = key => months.map((_, i) => sum(byProject, b => b[key][i]));
    return { months, byProject, baseline: tot('baseline'), actual: tot('actual'), forecast: tot('forecast') };
  }

  /* ---------- Scenario & Monte Carlo ---------- */
  const DEFAULT_SCENARIO = Object.freeze({ delayMonths: 0, escalationPct: 0, aprPct: 6.5 });

  // Deterministic what-if (no risk events): forecast + escalation + delay + financing carry.
  function scenarioCost(p, m, s) {
    const escalation = m.uncommitted * (s.escalationPct / 100);
    const prelims = s.delayMonths * p.prelimPerMonth;
    const subtotal = m.eac + escalation + prelims;
    const financing = subtotal * p.debtShare * (s.aprPct / 100) * (s.delayMonths / 12);
    return { escalation, prelims, financing, total: subtotal + financing };
  }

  function monteCarlo(p, m, s = DEFAULT_SCENARIO, iterations = 5000, seed = 20260930) {
    const rand = mulberry32(seed ^ hash(p.id));
    const totals = new Float64Array(iterations);
    const delays = new Float64Array(iterations);
    const riskHits = p.risks.map(() => 0);
    for (let i = 0; i < iterations; i++) {
      let total = 0;
      for (const k of m.pkgs) {
        const remaining = Math.max(0, k.eac - k.certified);
        const exposure = remaining > EPS ? k.uncommitted / remaining : 0;
        const f = triangular(rand(), 0.97, 1.0, 1.03 + 0.12 * exposure);
        total += k.certified + remaining * f;
      }
      total += m.uncommitted * (s.escalationPct / 100);
      let riskDelayWeeks = 0;
      p.risks.forEach((r, ri) => {
        const hit = rand() < r.p;
        const impact = triangular(rand(), r.min, r.ml, r.max);
        if (hit) { total += impact; riskDelayWeeks = Math.max(riskDelayWeeks, r.delayWeeks); riskHits[ri]++; }
      });
      const delayM = s.delayMonths + riskDelayWeeks / 4.345;
      total += delayM * p.prelimPerMonth;
      total += total * p.debtShare * (s.aprPct / 100) * (delayM / 12);
      totals[i] = total; delays[i] = delayM;
    }
    return summarise(Array.from(totals), p.bac, Array.from(delays));
  }

  function summarise(values, bac, delays) {
    const sorted = values.slice().sort((a, b) => a - b);
    const within = sorted.filter(v => v <= bac).length / Math.max(1, sorted.length);
    return {
      values, sorted, iterations: sorted.length,
      p10: percentile(sorted, 0.10), p50: percentile(sorted, 0.50),
      p80: percentile(sorted, 0.80), p90: percentile(sorted, 0.90),
      mean: sum(sorted) / Math.max(1, sorted.length),
      min: sorted[0], max: sorted[sorted.length - 1],
      probWithinBac: within,
      meanDelay: delays ? sum(delays) / Math.max(1, delays.length) : 0
    };
  }

  // Portfolio distribution: per-iteration sum across projects (independence assumed).
  function portfolioMonteCarlo(projectsMc, bac) {
    const n = Math.min(...projectsMc.map(r => r.values.length));
    const values = new Array(n).fill(0);
    projectsMc.forEach(r => { for (let i = 0; i < n; i++) values[i] += r.values[i]; });
    return summarise(values, bac);
  }

  function histogram(sorted, bins = 24) {
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    const width = (hi - lo) / bins || 1;
    const counts = new Array(bins).fill(0);
    sorted.forEach(v => { counts[Math.min(bins - 1, Math.floor((v - lo) / width))]++; });
    return { lo, width, counts, edges: counts.map((_, i) => lo + i * width), share: counts.map(c => c / sorted.length) };
  }

  function riskExposure(p) {
    return p.risks.map(r => ({ ...r, mean: (r.min + r.ml + r.max) / 3, expected: r.p * (r.min + r.ml + r.max) / 3 }))
      .sort((a, b) => b.expected - a.expected);
  }

  /* ---------- RAG (thresholds are deliberately explicit) ---------- */
  const THRESHOLDS = Object.freeze({
    spiAmber: 0.95, spiRed: 0.90, cpiAmber: 0.97, cpiRed: 0.93,
    confidenceGreen: 0.80, confidenceRed: 0.50
  });
  const RANK = { G: 0, A: 1, R: 2 };
  const worst = (...r) => r.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'G');

  function rag(m, mc) {
    const T = THRESHOLDS;
    const cost = m.headroom < 0 || mc.probWithinBac < T.confidenceRed || m.cpi < T.cpiRed ? 'R'
      : mc.probWithinBac < T.confidenceGreen || m.cpi < T.cpiAmber ? 'A' : 'G';
    const schedule = m.spi < T.spiRed ? 'R' : m.spi < T.spiAmber ? 'A' : 'G';
    return { cost, schedule, overall: worst(cost, schedule) };
  }

  /* ---------- Exceptions requiring a management decision ---------- */
  function exceptions(p, m, mc) {
    const out = [];
    const T = THRESHOLDS;
    if (m.headroom < 0) out.push({ sev: 'R', kind: 'Budget', title: `Forecast exceeds approved budget by SAR ${round(-m.headroom, 1)}M`, ask: 'Approve budget increase or de-scope', value: -m.headroom });
    if (mc.probWithinBac < T.confidenceGreen) {
      const gap = mc.p80 - p.bac;
      out.push({ sev: mc.probWithinBac < T.confidenceRed ? 'R' : 'A', kind: 'Contingency',
        title: `Only ${Math.round(mc.probWithinBac * 100)}% confidence of finishing within BAC` + (gap > 0 ? `; P80 is SAR ${round(gap, 1)}M over` : ''),
        ask: 'Decide contingency top-up or risk-mitigation spend', value: Math.max(0, gap) });
    }
    if (m.spi < T.spiAmber) out.push({ sev: m.spi < T.spiRed ? 'R' : 'A', kind: 'Schedule',
      title: `SPI ${m.spi.toFixed(2)} — indicative finish +${m.forecastDelay} month(s)`, ask: 'Require recovery programme from contractor', value: m.forecastDelay * p.prelimPerMonth });
    if (m.cpi < T.cpiAmber) out.push({ sev: m.cpi < T.cpiRed ? 'R' : 'A', kind: 'Cost efficiency',
      title: `CPI ${m.cpi.toFixed(2)} — performance-based EAC SAR ${round(m.eacCpi, 1)}M vs bottom-up SAR ${round(m.eac, 1)}M`, ask: 'Challenge the bottom-up forecast', value: Math.max(0, m.eacCpi - m.eac) });
    p.commitments.filter(c => c.status === 'Under Review').forEach(c => out.push({ sev: 'A', kind: 'Approval',
      title: `${c.id} ${c.title} (SAR ${round(c.original + c.variations)}M) awaiting approval`, ask: 'Approve / reject commitment', value: c.original + c.variations }));
    m.pkgs.filter(k => k.variance > 0.03 * k.budget).forEach(k => out.push({ sev: k.variance > 0.06 * k.budget ? 'R' : 'A', kind: 'Package overrun',
      title: `${k.name} forecast +SAR ${round(k.variance)}M (${(100 * k.variance / k.budget).toFixed(1)}%) over budget`, ask: 'Approve contingency transfer', value: k.variance }));
    if (m.uncommitted > 0.15 * p.bac) out.push({ sev: 'A', kind: 'Procurement',
      title: `SAR ${round(m.uncommitted, 1)}M (${Math.round(100 * m.uncommitted / p.bac)}% of BAC) still uncommitted — escalation exposure`, ask: 'Accelerate award to lock prices', value: m.uncommitted * 0.05 });
    return out.map(e => ({ ...e, project: p.name, projectId: p.id }));
  }

  /* ---------- Data integrity (so a reader can trust the numbers) ---------- */
  function integrityChecks(p, m, tol = 0.05) {
    const issues = [];
    const contRem = p.contingency.original - p.contingency.drawn;
    const budgetGap = m.budget + contRem - p.bac;
    if (Math.abs(budgetGap) > tol) issues.push(`Package budgets + remaining contingency differ from BAC by SAR ${round(budgetGap)}M`);
    const baseGap = sum(p.monthlyBaseline) - p.bac;
    if (Math.abs(baseGap) > tol) issues.push(`Cash-flow baseline differs from BAC by SAR ${round(baseGap)}M`);
    const actGap = sum(p.monthlyActual) - m.certified;
    if (Math.abs(actGap) > tol) issues.push(`Monthly actuals differ from certified ledger by SAR ${round(actGap)}M`);
    p.commitments.forEach(c => {
      if (c.certified > c.original + c.variations + tol) issues.push(`${c.id}: certified exceeds contract value`);
      if (!p.packages.some(k => k.code === c.pkg)) issues.push(`${c.id}: unknown package ${c.pkg}`);
    });
    m.pkgs.filter(k => k.eacRaised).forEach(k => issues.push(`${k.name}: EAC raised to committed value (SAR ${round(k.committed)}M)`));
    return issues;
  }

  function hash(str) { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

  const api = {
    mulberry32, triangular, percentile, monthIndex, monthKey, monthLabel,
    packageRollup, projectMetrics, cashflow, portfolioCashflow,
    DEFAULT_SCENARIO, scenarioCost, monteCarlo, portfolioMonteCarlo, histogram, riskExposure,
    THRESHOLDS, rag, exceptions, integrityChecks, round, sum
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MidadEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
