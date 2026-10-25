// Shared reference data and helpers for ASTCO Procurement & Logistics.

export const DISCIPLINES = [
  "Mechanical (HVAC)",
  "Plumbing & Drainage",
  "Fire Fighting",
  "Electrical",
  "ELV / Low Current",
  "Fire Alarm",
  "Instrumentation & Controls",
  "Piping",
  "Civil & Structural",
  "Structural Steel",
  "Architectural & Finishes",
  "Elevators & Escalators",
  "Facade & Glazing",
  "Landscaping",
  "IT & Networking",
  "Safety & PPE",
  "Tools & Consumables",
  "General Supplies",
  "Logistics & Freight",
  "Services & Subcontracting",
];

export const VENDOR_TYPES = [
  "Manufacturer",
  "Authorized Distributor",
  "Trader / Stockist",
  "Subcontractor",
  "Service Provider",
  "Freight Forwarder",
];

export const INCOTERMS = ["EXW", "FCA", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];
export const UNITS = ["pcs", "set", "lot", "m", "m2", "m3", "kg", "ton", "ltr", "roll", "box", "lm", "nos"];
export const CURRENCIES = ["SAR", "USD", "EUR", "AED", "GBP"];

export function money(value, currency = "SAR") {
  if (value === null || value === undefined || value === "" || Number.isNaN(Number(value))) return "—";
  return `${currency} ${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function shortDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

// Closing date is treated as end of that day (local time).
export function isClosed(closingDate) {
  if (!closingDate) return false;
  const end = new Date(`${closingDate}T23:59:59`);
  return Date.now() > end.getTime();
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const end = new Date(`${dateStr}T23:59:59`);
  return Math.ceil((end.getTime() - Date.now()) / 86400000);
}

// Only http(s) links may be rendered as hrefs — blocks javascript:/data: URLs that a vendor
// could store in an attachment field (stored XSS against procurement users).
export function safeUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url, window.location.origin);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Cost summary and procurement value added, per discipline.
 *
 * Only rows in `currency` are summed; other currencies are counted in `excluded`
 * rather than mixed in. A PO belongs to the discipline of the RFQ it was awarded from.
 *
 * - budget:        internal budget of every non-cancelled RFQ
 * - committed:     value of non-cancelled purchase orders
 * - awardedBudget: budget of the RFQs those POs were awarded from (the baseline)
 * - savings:       awardedBudget - committed, for awarded RFQs that have a budget
 *                  ("value added vs budget"; negative = overrun)
 * - competition:   average valid quote - PO value, for awarded RFQs with 2+ valid quotes
 *                  ("value added by competitive bidding")
 * - pipeline:      budget of RFQs not yet awarded (Draft / Issued / Closed)
 */
export function costSummaryByDiscipline({ rfqs = [], pos = [], quotes = [] }, currency = "SAR") {
  const rows = {};
  const excluded = { rfqs: 0, pos: 0 };
  const row = (d) =>
    (rows[d] = rows[d] || {
      discipline: d,
      rfqCount: 0,
      budget: 0,
      committed: 0,
      poCount: 0,
      awardedBudget: 0,
      savings: 0,
      competition: 0,
      competedPos: 0,
      pipeline: 0,
    });
  const cur = (x) => (x.currency || "SAR") === currency;
  const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  const rfqById = {};

  rfqs.forEach((r) => {
    rfqById[r.id] = r;
    if (r.status === "Cancelled") return;
    if (!cur(r)) return void excluded.rfqs++;
    const g = row(r.discipline || "Unclassified");
    g.rfqCount += 1;
    const budget = num(r.budget);
    if (budget !== null) {
      g.budget += budget;
      if (r.status !== "Awarded") g.pipeline += budget;
    }
  });

  const validQuotesByRfq = {};
  quotes
    .filter((q) => q.status !== "Withdrawn" && cur(q) && num(q.total_price) !== null)
    .forEach((q) => (validQuotesByRfq[q.rfq_id] = validQuotesByRfq[q.rfq_id] || []).push(Number(q.total_price)));

  pos.forEach((p) => {
    if (p.status === "Cancelled") return;
    if (!cur(p)) return void excluded.pos++;
    const amount = num(p.amount);
    if (amount === null) return;
    const rfq = rfqById[p.rfq_id];
    const g = row(rfq?.discipline || "Unassigned");
    g.committed += amount;
    g.poCount += 1;
    const budget = rfq && cur(rfq) ? num(rfq.budget) : null;
    if (budget !== null) {
      g.awardedBudget += budget;
      g.savings += budget - amount;
    }
    const qs = validQuotesByRfq[p.rfq_id] || [];
    if (qs.length >= 2) {
      g.competition += qs.reduce((s, x) => s + x, 0) / qs.length - amount;
      g.competedPos += 1;
    }
  });

  const list = Object.values(rows)
    .map((g) => ({ ...g, savingsPct: g.awardedBudget ? (g.savings / g.awardedBudget) * 100 : null }))
    .sort((a, b) => b.committed - a.committed || b.budget - a.budget);
  const sum = (k) => list.reduce((s, g) => s + g[k], 0);
  const totals = {
    discipline: "Total",
    rfqCount: sum("rfqCount"),
    budget: sum("budget"),
    committed: sum("committed"),
    poCount: sum("poCount"),
    awardedBudget: sum("awardedBudget"),
    savings: sum("savings"),
    competition: sum("competition"),
    competedPos: sum("competedPos"),
    pipeline: sum("pipeline"),
  };
  totals.savingsPct = totals.awardedBudget ? (totals.savings / totals.awardedBudget) * 100 : null;
  totals.valueAdded = totals.savings;
  return { rows: list, totals, excluded, currency };
}

/**
 * Server-trustworthy lateness check. created_date / updated_date are set by the
 * platform, not the vendor, and closing_date comes from the procurement-only RFQ row
 * (not the vendor-editable invitation copy).
 */
export function lateness(quote, rfqClosingDate) {
  if (!rfqClosingDate) return null;
  const end = new Date(`${rfqClosingDate}T23:59:59`).getTime();
  if (new Date(quote.created_date).getTime() > end) return "LATE SUBMISSION";
  if (quote.updated_date && new Date(quote.updated_date).getTime() > end) return "MODIFIED AFTER CLOSING";
  return null;
}

export function eqi(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

// Sequential document number, e.g. RFQ-2026-0007
export function docNo(prefix, count) {
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String((count || 0) + 1).padStart(4, "0")}`;
}

/**
 * Which registered vendors should receive an RFQ.
 * - Suspended vendors never receive RFQs.
 * - Discipline must be in the vendor's approved disciplines (AVL).
 * - Vendor type (if chosen) must match.
 * - Product type (if given) is a "strong" match when it is in the vendor's approved
 *   product types or appears in their own catalog.
 * Returns [{ vendor, strong }] for all discipline-level matches.
 */
export function matchVendors(vendors, products, { discipline, vendor_type, product_type }) {
  const byVendor = {};
  (products || []).forEach((p) => {
    const key = (p.owner_email || "").toLowerCase();
    (byVendor[key] = byVendor[key] || []).push(p);
  });
  return (vendors || [])
    .filter((v) => v.status !== "Suspended")
    .filter((v) => (v.disciplines || []).includes(discipline))
    .filter((v) => !vendor_type || v.vendor_type === vendor_type)
    .map((v) => {
      let strong = true;
      if (product_type) {
        const pt = product_type.trim().toLowerCase();
        const inTags = (v.product_types || []).some((t) => t.toLowerCase().includes(pt) || pt.includes(t.toLowerCase()));
        const inCatalog = (byVendor[(v.contact_email || "").toLowerCase()] || []).some(
          (p) =>
            (p.product_type || "").toLowerCase().includes(pt) ||
            (p.product_name || "").toLowerCase().includes(pt)
        );
        strong = inTags || inCatalog;
      }
      return { vendor: v, strong };
    })
    .sort((a, b) => Number(b.strong) - Number(a.strong) || (b.vendor.rating || 0) - (a.vendor.rating || 0));
}

/**
 * Weighted bid scoring (same weights as the reference design):
 * Technical 40%, Commercial price 40%, Lead time 20%.
 * Price and lead time are scored relative to the best compliant offer.
 */
export function scoreBids(quotes, evaluations, rfqClosingDate) {
  const evalByQuote = {};
  (evaluations || []).forEach((e) => (evalByQuote[e.quotation_id] = e));
  const isOut = (q) => q.status === "Withdrawn" || evalByQuote[q.id]?.compliant === false || !!lateness(q, rfqClosingDate);
  const live = quotes.filter((q) => !isOut(q));
  const minPrice = Math.min(...live.map((q) => Number(q.total_price) || Infinity));
  const minLead = Math.min(...live.map((q) => Number(q.lead_time_days) || Infinity));
  return quotes.map((q) => {
    const ev = evalByQuote[q.id];
    const excluded = isOut(q);
    const tech = ev?.tech_score ?? null;
    const priceScore = !excluded && q.total_price ? (minPrice / Number(q.total_price)) * 100 : 0;
    const leadScore = !excluded && q.lead_time_days ? (minLead / Number(q.lead_time_days)) * 100 : 0;
    const composite = excluded || tech === null ? null : tech * 0.4 + priceScore * 0.4 + leadScore * 0.2;
    return { quote: q, evaluation: ev, tech, priceScore, leadScore, composite, excluded, late: lateness(q, rfqClosingDate) };
  });
}

export const STATUS_STYLES = {
  // generic
  Draft: "bg-slate-800 text-slate-300 border-slate-700",
  Issued: "bg-blue-950 text-blue-300 border-blue-800",
  Closed: "bg-slate-800 text-slate-300 border-slate-700",
  Awarded: "bg-emerald-950 text-emerald-300 border-emerald-800",
  Cancelled: "bg-rose-950 text-rose-300 border-rose-800",
  Invited: "bg-amber-950 text-amber-300 border-amber-800",
  Active: "bg-emerald-950 text-emerald-300 border-emerald-800",
  Suspended: "bg-rose-950 text-rose-300 border-rose-800",
  Sent: "bg-blue-950 text-blue-300 border-blue-800",
  Viewed: "bg-indigo-950 text-indigo-300 border-indigo-800",
  Quoted: "bg-emerald-950 text-emerald-300 border-emerald-800",
  Declined: "bg-rose-950 text-rose-300 border-rose-800",
  Submitted: "bg-emerald-950 text-emerald-300 border-emerald-800",
  Withdrawn: "bg-rose-950 text-rose-300 border-rose-800",
  Open: "bg-rose-950 text-rose-300 border-rose-800",
  Resolved: "bg-emerald-950 text-emerald-300 border-emerald-800",
  "In Progress": "bg-amber-950 text-amber-300 border-amber-800",
  Available: "bg-emerald-950 text-emerald-300 border-emerald-800",
  Reserved: "bg-blue-950 text-blue-300 border-blue-800",
  "Issued to Site": "bg-indigo-950 text-indigo-300 border-indigo-800",
  "Blocked (OS&D)": "bg-rose-950 text-rose-300 border-rose-800",
  Approved: "bg-emerald-950 text-emerald-300 border-emerald-800",
  "Under Review": "bg-amber-950 text-amber-300 border-amber-800",
  "In RFQ": "bg-blue-950 text-blue-300 border-blue-800",
  "RFQ Raised": "bg-blue-950 text-blue-300 border-blue-800",
  Rejected: "bg-rose-950 text-rose-300 border-rose-800",
  Fulfilled: "bg-emerald-950 text-emerald-300 border-emerald-800",
  Admin: "bg-rose-950 text-rose-300 border-rose-800",
  Management: "bg-indigo-950 text-indigo-300 border-indigo-800",
  Staff: "bg-blue-950 text-blue-300 border-blue-800",
  Ordered: "bg-indigo-950 text-indigo-300 border-indigo-800",
  Delivered: "bg-emerald-950 text-emerald-300 border-emerald-800",
  "Delivered to Site": "bg-emerald-950 text-emerald-300 border-emerald-800",
  Critical: "bg-rose-950 text-rose-300 border-rose-800",
  Urgent: "bg-amber-950 text-amber-300 border-amber-800",
  Normal: "bg-slate-800 text-slate-300 border-slate-700",
  Moderate: "bg-amber-950 text-amber-300 border-amber-800",
  Minor: "bg-slate-800 text-slate-300 border-slate-700",
};
