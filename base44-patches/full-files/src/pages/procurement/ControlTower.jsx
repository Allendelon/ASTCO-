import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { DollarSign, FileText, Ship, Users, TriangleAlert, Clock, CheckCircle2, LayoutDashboard, PiggyBank, Scale, Wallet } from "lucide-react";
import { useLists } from "@/lib/useData";
import { Panel, PageHeader, StatCard, Loading, StatusPill, Btn } from "@/components/pl/kit";
import { money, shortDate, daysUntil, costSummaryByDiscipline } from "@/lib/procurement";
import { cn } from "@/lib/utils";

export default function ControlTower() {
  const { data, loading } = useLists({
    rfqs: "RFQ",
    quotes: "Quotation",
    pos: "PurchaseOrder",
    vendors: "Vendor",
    shipments: "Shipment",
    ncrs: "NCR",
    osd: "OSDReport",
    cwps: "CWP",
  });

  const stats = useMemo(() => {
    const rfqs = data.rfqs || [];
    const pos = data.pos || [];
    const committed = pos.filter((p) => p.status !== "Cancelled").reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const open = rfqs.filter((r) => r.status === "Issued");
    const closingSoon = open
      .map((r) => ({ ...r, days: daysUntil(r.closing_date) }))
      .filter((r) => r.days !== null && r.days <= 3)
      .sort((a, b) => a.days - b.days);
    const pipeline = ["Draft", "Issued", "Closed", "Awarded"].map((s) => ({
      stage: s,
      count: rfqs.filter((r) => r.status === s).length,
    }));
    const byDiscipline = {};
    rfqs.forEach((r) => (byDiscipline[r.discipline] = (byDiscipline[r.discipline] || 0) + 1));
    const quotesByRfq = {};
    (data.quotes || []).forEach((q) => (quotesByRfq[q.rfq_id] = (quotesByRfq[q.rfq_id] || 0) + 1));
    const awaitingEval = open.filter((r) => (quotesByRfq[r.id] || 0) > 0).length;
    const cwps = data.cwps || [];
    const readiness = cwps.length
      ? cwps.reduce((s, c) => s + (c.total_items ? (c.on_site / c.total_items) * 100 : 0), 0) / cwps.length
      : null;
    return {
      committed,
      open: open.length,
      closingSoon,
      pipeline,
      awaitingEval,
      byDiscipline: Object.entries(byDiscipline).map(([discipline, count]) => ({ discipline, count })),
      activeVendors: (data.vendors || []).filter((v) => v.status !== "Suspended").length,
      inTransit: (data.shipments || []).filter((s) => s.status !== "Delivered to Site").length,
      openNcr: (data.ncrs || []).filter((n) => n.status === "Open").length,
      openOsd: (data.osd || []).filter((o) => o.status !== "Closed").length,
      readiness,
    };
  }, [data]);

  const cost = useMemo(
    () => costSummaryByDiscipline({ rfqs: data.rfqs || [], pos: data.pos || [], quotes: data.quotes || [] }),
    [data]
  );

  if (loading) return <Loading />;

  return (
    <>
      <PageHeader
        icon={LayoutDashboard}
        title="Procurement Control Tower"
        subtitle="Live position of requisitions, supplier quotations, commitments and site material flow."
        actions={
          <Link to="/rfqs?new=1">
            <Btn>
              <FileText className="w-4 h-4" /> New Requisition / RFQ
            </Btn>
          </Link>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Committed PO Value" value={money(stats.committed)} icon={DollarSign} tone="blue" hint={`${(data.pos || []).length} purchase orders`} />
        <StatCard label="Open RFQs" value={stats.open} icon={FileText} tone="amber" hint={`${stats.awaitingEval} with quotes awaiting evaluation`} />
        <StatCard label="Registered Vendors" value={stats.activeVendors} icon={Users} tone="emerald" hint="Invitation-only AVL" />
        <StatCard
          label="Shipments in Transit"
          value={stats.inTransit}
          icon={Ship}
          tone="indigo"
          hint={`${stats.openNcr} open NCR • ${stats.openOsd} open OS&D${stats.readiness !== null ? ` • CWP ${stats.readiness.toFixed(1)}%` : ""}`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Panel className="p-5 lg:col-span-2">
          <h3 className="font-bold text-sm text-white">RFQs by Discipline</h3>
          <p className="text-xs text-slate-400 mb-4">Where sourcing effort is concentrated</p>
          <div className="h-64">
            {stats.byDiscipline.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.byDiscipline}>
                  <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                  <XAxis dataKey="discipline" tick={{ fill: "#94a3b8", fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
                  <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: "#0a0f1d", border: "1px solid #1e293b", color: "#e2e8f0", fontSize: 12 }} />
                  <Bar dataKey="count" fill="#3b82f6" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">No RFQs yet — raise your first requisition.</div>
            )}
          </div>
          <div className="grid grid-cols-4 gap-2 mt-4">
            {stats.pipeline.map((p) => (
              <div key={p.stage} className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-center">
                <div className="text-lg font-mono font-bold text-white">{p.count}</div>
                <div className="text-[10px] text-slate-400 uppercase">{p.stage}</div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel className="p-5">
          <h3 className="font-bold text-sm text-white flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-400" /> Closing Within 3 Days
          </h3>
          <p className="text-xs text-slate-400 mb-3">RFQs about to close — chase non-responsive vendors</p>
          <div className="space-y-2">
            {stats.closingSoon.length === 0 && (
              <div className="p-4 rounded-lg bg-emerald-950/30 border border-emerald-800/50 text-xs text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" /> Nothing closing imminently.
              </div>
            )}
            {stats.closingSoon.map((r) => (
              <Link
                key={r.id}
                to={`/rfqs/${r.id}`}
                className="block p-3 rounded-lg bg-amber-950/30 border border-amber-800/50 hover:border-amber-600 transition"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-amber-200">{r.rfq_no}</span>
                  <StatusPill value={r.priority} />
                </div>
                <div className="text-[11px] text-slate-300 mt-1">{r.title}</div>
                <div className="text-[10px] text-slate-400 mt-1 font-mono">
                  Closes {shortDate(r.closing_date)} ({r.days < 0 ? "overdue" : `${r.days}d`})
                </div>
              </Link>
            ))}
          </div>
          {(stats.openNcr > 0 || stats.openOsd > 0) && (
            <div className="mt-4 p-3 rounded-lg bg-rose-950/30 border border-rose-800/50 text-xs text-rose-200 flex items-start gap-2">
              <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {stats.openNcr} open quality NCR and {stats.openOsd} open OS&D items may constrain work packages.
              </span>
            </div>
          )}
        </Panel>
      </div>

      <CostSummary cost={cost} />
    </>
  );
}

const pct = (v) => (v === null || v === undefined ? "—" : `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(1)}%`);
const signed = (v, currency) => (v < 0 ? `−${money(-v, currency)}` : money(v, currency));
const tone = (v) => (v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-slate-400");
const compact = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : `${v}`);

function CostSummary({ cost }) {
  const { rows, totals, excluded, currency } = cost;
  const chart = rows.filter((r) => r.budget || r.committed).map((r) => ({ discipline: r.discipline, Budget: r.budget, Committed: r.committed }));
  return (
    <Panel className="p-5 space-y-5">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-2">
        <div>
          <h3 className="font-bold text-sm text-white flex items-center gap-2">
            <PiggyBank className="w-4 h-4 text-emerald-400" /> Cost Summary &amp; Value Added by Discipline
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Budget vs committed spend, and the value procurement added through budget savings and competitive bidding ({currency}).
          </p>
        </div>
        {(excluded.rfqs > 0 || excluded.pos > 0) && (
          <span className="text-[11px] text-amber-300">
            {excluded.rfqs} RFQ(s) and {excluded.pos} PO(s) in other currencies are not included.
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Budget" value={money(totals.budget, currency)} icon={Wallet} tone="indigo" hint={`${totals.rfqCount} active RFQs`} />
        <StatCard label="Committed (Awarded POs)" value={money(totals.committed, currency)} icon={DollarSign} tone="blue" hint={`${totals.poCount} POs • ${money(totals.pipeline, currency)} budget still in pipeline`} />
        <StatCard
          label="Value Added vs Budget"
          value={signed(totals.savings, currency)}
          icon={PiggyBank}
          tone={totals.savings >= 0 ? "emerald" : "rose"}
          hint={totals.savingsPct === null ? "No awarded RFQ with a budget yet" : `${pct(totals.savingsPct)} of awarded budget ${totals.savings >= 0 ? "saved" : "overrun"}`}
        />
        <StatCard label="Value Added by Competition" value={signed(totals.competition, currency)} icon={Scale} tone="amber" hint="Average quote minus awarded price (RFQs with 2+ bids)" />
      </div>

      {chart.length > 0 && (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart}>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
              <XAxis dataKey="discipline" tick={{ fill: "#94a3b8", fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
              <YAxis tickFormatter={compact} tick={{ fill: "#94a3b8", fontSize: 10 }} />
              <Tooltip formatter={(v) => money(v, currency)} contentStyle={{ background: "#0a0f1d", border: "1px solid #1e293b", color: "#e2e8f0", fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
              <Bar dataKey="Budget" fill="#6366f1" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Committed" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs text-slate-300">
          <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-[11px] border-b border-slate-800 tracking-wider">
            <tr>
              <th className="p-3">Discipline</th>
              <th className="p-3 text-right">RFQs</th>
              <th className="p-3 text-right">Budget</th>
              <th className="p-3 text-right">Committed</th>
              <th className="p-3 text-right">Value Added vs Budget</th>
              <th className="p-3 text-right">Saving %</th>
              <th className="p-3 text-right">Competition Value</th>
              <th className="p-3 text-right">Open Pipeline</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 font-mono">
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-slate-500 font-sans">
                  No costed RFQs yet. Enter an internal budget on each RFQ to track value added.
                </td>
              </tr>
            )}
            {[...rows, ...(rows.length ? [totals] : [])].map((r) => {
              const isTotal = r === totals;
              return (
                <tr key={r.discipline} className={cn(isTotal ? "bg-slate-950/80 font-bold text-white" : "hover:bg-slate-800/40")}>
                  <td className="p-3 font-sans">{r.discipline}</td>
                  <td className="p-3 text-right">{r.rfqCount}</td>
                  <td className="p-3 text-right">{money(r.budget, currency)}</td>
                  <td className="p-3 text-right">{money(r.committed, currency)}</td>
                  <td className={cn("p-3 text-right", r.poCount ? tone(r.savings) : "text-slate-500")}>{r.poCount ? signed(r.savings, currency) : "—"}</td>
                  <td className={cn("p-3 text-right", tone(r.savingsPct || 0))}>{pct(r.savingsPct)}</td>
                  <td className={cn("p-3 text-right", r.competedPos ? tone(r.competition) : "text-slate-500")}>{r.competedPos ? signed(r.competition, currency) : "—"}</td>
                  <td className="p-3 text-right">{money(r.pipeline, currency)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">
        Value added vs budget = internal budget of awarded RFQs minus their PO value (negative = overrun). Competition value = average valid quote minus the awarded
        price. Cancelled RFQs/POs and withdrawn quotes are excluded.
      </p>
    </Panel>
  );
}
