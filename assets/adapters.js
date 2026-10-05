/*
 * Midad Executive Suite — connectors to the other ASTCO apps.
 *
 *  • Crystal Gallery cost model feed  (assets/feeds/crystal-gallery-costing.js)
 *      Same generated file the IPC System consumes, so both apps price CG-JED identically.
 *  • ASTCO 4D Planner "Monthly cash flow (.csv)" export  → replaces a project's baseline profile.
 *  • midad-feed/1 JSON                                     → adds or replaces a whole project.
 *
 * Pure functions, no DOM. Browser: window.MidadAdapters; Node: require().
 */
(function (root) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const M = 1e6;

  const COSTING_GROUPS = [
    { digit: '1', code: 'SUB', name: 'Enabling, Shoring & Substructure' },
    { digit: '2', code: 'FRM', name: 'RC Frame & Slabs' },
    { digit: '3', code: 'ENV', name: 'Envelope, Facade & Roofing' },
    { digit: '4', code: 'MEP', name: 'MEP, Central Plant & Vertical Transport' },
    { digit: '5', code: 'FIN', name: 'Finishes, Fit-out & External Works' },
    { digit: '6', code: 'TCH', name: 'Testing, Commissioning & Handover' }
  ];

  // Linear cost loading of each priced line over its working days, bucketed into calendar months.
  function costingToMonthly(costing) {
    const start = new Date(costing.constructionStart + 'T00:00:00Z');
    const dayToMonth = d => {
      const dt = new Date(start.getTime() + d * 86400000);
      return (dt.getUTCFullYear() - start.getUTCFullYear()) * 12 + (dt.getUTCMonth() - start.getUTCMonth());
    };
    const nMonths = dayToMonth(costing.durationDays - 1) + 1;
    const out = new Array(nMonths).fill(0);
    costing.lines.forEach(l => {
      const s = l.startDay, e = Math.max(l.finishDay, l.startDay + 1);
      for (let d = s; d < e; d++) out[Math.min(nMonths - 1, dayToMonth(d))] += l.amt / (e - s);
    });
    return out;
  }

  /*
   * Builds a portfolio project from the cost-model feed.
   * Contract value = out-turn priced bill; contingency = the model's reserve; BAC = with contingency.
   * Scope-gap exposures are passed in as risks because the priced bill excludes them.
   */
  function projectFromCosting(costing, meta) {
    const groups = COSTING_GROUPS.map(g => {
      const lines = costing.lines.filter(l => l.code.replace('CG-', '').charAt(0) === g.digit);
      const amt = lines.reduce((s, l) => s + l.amt, 0) / M;
      return { code: g.code, name: g.name, budget: amt, eac: amt, pct: 0, planPct: 0, lines: lines.length };
    }).filter(g => g.lines > 0);
    const outturn = costing.totals.outturn / M;
    const contingency = costing.totals.contingency / M;
    const baseline = costingToMonthly(costing).map(v => v / M);
    // Contingency is held at the end of the cash profile scaled pro-rata (as the planner does).
    const scale = (outturn + contingency) / outturn;
    return {
      ...meta,
      bac: outturn + contingency,
      start: costing.constructionStart.slice(0, 7),
      contingency: { original: contingency, drawn: 0 },
      packages: groups.map(({ lines, ...g }) => g),
      commitments: [],
      monthlyBaseline: baseline.map(v => v * scale),
      monthlyActual: [],
      feed: {
        kind: 'cost-model', title: costing.source.title, ref: costing.source.ref,
        commit: costing.source.commit, artifact: costing.source.artifact,
        lines: costing.lines.length, outturn, contingency, base: costing.totals.base / M
      }
    };
  }

  /* ---------- 4D Planner monthly cash-flow CSV ---------- */
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ''));
  }

  // Planner labels are en-GB short dates, e.g. "Mar 27" or "Sept 27".
  function plannerMonth(label) {
    const m = String(label).trim().match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+'?(\d{2,4})$/);
    if (!m) return null;
    const mi = MONTHS.findIndex(x => x.toLowerCase() === m[1].toLowerCase());
    if (mi < 0) return null;
    const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    return `${y}-${String(mi + 1).padStart(2, '0')}`;
  }

  function parsePlannerCashflow(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('CSV has no data rows');
    const head = rows[0].map(h => h.trim().toLowerCase());
    const col = name => head.findIndex(h => h === name || h.startsWith(name + '_'));
    const iMonth = col('month'), iBase = col('baseline'), iFcst = head.indexOf('forecast'), iCur = col('currency');
    if (iMonth < 0 || iBase < 0 || iFcst < 0) throw new Error('Not a 4D Planner cash-flow export (needs month, baseline_*, forecast columns)');
    const data = rows.slice(1);
    const start = plannerMonth(data[0][iMonth]);
    if (!start) throw new Error(`Unrecognised month label "${data[0][iMonth]}"`);
    const currency = iCur >= 0 ? (data[0][iCur] || '').trim() : '';
    const toM = v => (Number(String(v).replace(/[^0-9.\-]/g, '')) || 0) / M;
    return {
      start, currency,
      baseline: data.map(r => toM(r[iBase])),
      forecast: data.map(r => toM(r[iFcst])),
      months: data.length
    };
  }

  // Applies a planner export to a project: baseline profile is rescaled to BAC so the
  // cash plan still reconciles; the scale factor is reported so the gap is visible.
  function applyPlannerCashflow(project, parsed) {
    const total = parsed.baseline.reduce((s, v) => s + v, 0);
    if (total <= 0) throw new Error('Planner baseline column sums to zero');
    const factor = project.bac / total;
    return {
      project: { ...project, start: parsed.start, monthlyBaseline: parsed.baseline.map(v => v * factor),
        feed: { ...(project.feed || {}), planner: { months: parsed.months, total, factor, currency: parsed.currency, start: parsed.start } } },
      plannerTotal: total, factor
    };
  }

  /* ---------- midad-feed/1 ---------- */
  const REQUIRED = ['id', 'name', 'bac', 'start', 'contingency', 'packages', 'commitments', 'risks', 'monthlyBaseline', 'monthlyActual'];
  function parseFeed(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('File is not valid JSON'); }
    if (obj.schema !== 'midad-feed/1') throw new Error('Expected "schema": "midad-feed/1"');
    const p = obj.project;
    if (!p || typeof p !== 'object') throw new Error('Missing "project" object');
    const missing = REQUIRED.filter(k => !(k in p));
    if (missing.length) throw new Error('Project is missing: ' + missing.join(', '));
    if (!/^\d{4}-\d{2}$/.test(p.start)) throw new Error('"start" must be YYYY-MM');
    ['debtShare', 'prelimPerMonth'].forEach(k => { if (typeof p[k] !== 'number') p[k] = k === 'debtShare' ? 0.6 : 0; });
    p.code = p.code || String(p.id).toUpperCase().slice(0, 4);
    return p;
  }

  const api = { COSTING_GROUPS, costingToMonthly, projectFromCosting, parseCsv, plannerMonth, parsePlannerCashflow, applyPlannerCashflow, parseFeed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MidadAdapters = api;
})(typeof window !== 'undefined' ? window : globalThis);
