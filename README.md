# Midad Executive Suite

Senior-management view of the ASTCO capital project portfolio: cost, schedule, risk-adjusted confidence and the decisions the board needs to take. It sits on top of the operational ASTCO apps (4D Planner, Take-off & 5D cost model, IPC System, Procurement).

## Run

No build step. Serve the folder with any static server:

```bash
npm start            # npx http-server -p 8080 -c-1 .
npm test             # node:test, no dependencies (Node 18+)
```

Opening `index.html` from disk also works. External requests: Chart.js **4.4.0** UMD from jsDelivr and Google Fonts. If Chart.js cannot load, the page says so and every figure and table still renders.

## Views

| View | For | What it answers |
|---|---|---|
| Portfolio | Board / ExCo | Budget vs forecast, confidence of finishing within budget, project RAG, decisions required, 12-month funding requirement |
| Project review | Sponsor | S-curve, contingency (drawn / forecast to draw / free), cost breakdown with package CPI/SPI, commitments, risk register |
| Risk & scenarios | CFO / risk | Seeded Monte Carlo (P50/P80/P90, P(≤BAC)), slippage / escalation / financing stress, method and RAG thresholds |
| Connected apps | PMO | What each ASTCO app owns, what flows up, imports |
| Board report | Board pack | One printable summary with generated commentary (Print → Save as PDF) |

## The numbers model

All money is SAR millions. `engine.integrityChecks` flags any project that breaks these rules, and the UI shows the result:

- Σ package budget + remaining contingency = BAC. Package budget is the **current** budget (original + approved contingency transfers).
- Σ monthly baseline = BAC; Σ monthly actuals = Σ gross certified.
- Package EAC is never below committed value; if a new commitment exceeds it, EAC is raised and flagged.
- **Headroom = BAC − EAC = free contingency.**
- EVM: EV = Σ budget × physical %, PV = Σ budget × planned %, AC = gross certified. Performance-based EAC (AC + (BAC − EV)/CPI) is shown next to the bottom-up EAC as a challenge.
- Monte Carlo: 5,000 iterations, fixed seed (figures don't move between meetings unless the data does). Risks in the register are unmitigated and excluded from EAC.
- RAG thresholds are constants in `assets/engine.js` (`THRESHOLDS`) and printed on the Risk page.

The four sample construction projects are illustrative. **Crystal Gallery Mall is built from real app data** (see below).

## Connections to the other ASTCO apps

There is **no live sync**. Planner, Take-off and IPC keep data in each viewer's browser or their own page store; Procurement is a separate Node/SQLite server with no export API. The suite connects in three ways:

1. **Shared cost-model feed (live link).** `assets/feeds/crystal-gallery-costing.js` is the same generated file the IPC System uses (`tools/sync_costing.py` on branch `claude/ascto-ipc-system-app-73nzq4`, sourced from the take-off on `claude/stoic-hypatia-456ykd`). The suite builds Crystal Gallery's packages, phasing (linear over each line's working days, the planner's method), contingency and BAC from it: SAR 326.77M out-turn + SAR 16.34M contingency = **SAR 343.11M**, the same contract sum the IPC System certifies against. To refresh: re-run the sync there and copy the file here. `npm test` checks the totals.
2. **4D Planner cash-flow CSV** (Planner → Data → Monthly cash flow). Connected apps → *Import 4D Planner cash flow* replaces a project's baseline profile, rescaled to BAC. Rejects non-SAR exports and start-month mismatches on projects with actuals.
3. **`midad-feed/1` JSON** for anything else (IPC certified totals, procurement awards): `{"schema":"midad-feed/1","project":{…}}` with the same shape as a project in `assets/data.js`. *Download template from current project* gives a valid example.

Imports, recorded commitments and app URLs are stored in the viewer's own browser (`localStorage`) and can be discarded per project.

Crystal Gallery scope gaps (FLS MEP scope, cinema equipment, FF&E/signage) come from the take-off's scope-gap register. **Their probabilities and ranges are assumptions**, as is `prelimPerMonth` for that project. Confirm them with the QS.

## Files

```
index.html                         page shell
assets/styles.css                  tokens (light/dark), layout, print
assets/data.js                     portfolio data, app registry, linked-project metadata
assets/feeds/crystal-gallery-costing.js   generated cost-model feed (do not edit)
assets/engine.js                   metrics, EVM, cash flow, Monte Carlo, RAG, exceptions, integrity
assets/adapters.js                 cost-model feed, planner CSV, midad-feed/1
assets/app.js                      UI
tests/engine.test.js               engine + adapter tests
```
