# ASCTO — Interim Payment Certificate (IPC) System

A browser app for preparing, checking and approving FIDIC-style Interim Payment Certificates across multiple projects and contractor packages.

## Run it

No build step and no dependencies. Serve the folder with any static server, for example:

```bash
npx http-server -p 8080 .
# then open http://localhost:8080
```

Opening `index.html` directly from disk also works. External assets come from CDNs: Tailwind Play CDN, Chart.js 4.4.1 (jsDelivr) and Google Fonts.

## Tests

The valuation engine (`assets/js/calc.js`) is pure JavaScript and is unit-tested with Node's built-in test runner (Node 18+):

```bash
npm test        # = node --test tests/*.test.js
```

## Features

- **Contractors hub**: consolidated commitments, certified value, retention and current net due per project, with sector filters and a cross-valuation matrix.
- **IPC certificate**: printable FIDIC Clause 14.6 statement with Amount to Date / Previous / This Period columns, amount in words, and signatory blocks.
- **BOQ valuation**: inline "this period" quantities, search, and overrun flags (▲) when the cumulative quantity exceeds the contract quantity.
- **Variations**: approved or pending VOs with previous % and % to date. Only approved VOs affect the revised sum.
- **Materials on site (MOS)**: previous and current stored quantities at the contractual valuation %. A drawdown produces a negative period movement.
- **Deductions**: retention (rate and cap), advance recovery (rate, capped at advance paid), and other deductions (NCR / penalties).
- **Payment ledger**: per-IPC movements, with a "Mark Paid" step for certified certificates.
- **Approvals workflow**: Approve or Return with a reason. Every action goes into an audit trail per contractor.
- **New IPC cycle**: blocked until the current IPC is approved. On rollover it locks quantities, VO % and MOS as "previous", writes the ledger row, and advances the period and dates.
- **Analytics**: S-curve and per-IPC net payable charts, built from the ledger.
- **Persistence**: saved automatically to `localStorage`, with JSON **Export / Import** for backup and **Reset Demo** to restore the seed data.

## Calculation rules (`calc.js`)

| Line | Rule |
|---|---|
| Gross (A) | BOQ (prev + this qty) × rate + approved VOs × % + MOS qty × rate × valuation % |
| Retention | `retentionRate` × (BOQ + VO), capped at `retentionCapRate` × revised contract sum. MOS is excluded. |
| Advance recovery | `advanceRecoveryRate` × gross, capped at the advance paid |
| VAT | `vatRate` × net (default 15%) |
| Period | Always **cumulative − previous** for every line, so A − B = C reconciles in all three columns |

## Known limitations (read before real use)

- **Single-user, browser-local data.** No server, authentication or role separation. Anyone using the browser can approve. Data lives in that one browser's `localStorage`.
- **Seeded history is synthetic.** For the demo contractors, the earlier IPC ledger rows are generated so that they sum to the "Previous Certified" figures. They are not real records.
- **The S-curve baseline is indicative.** It is a logistic curve over the project dates, not a programme baseline.
- **Tailwind Play CDN** is intended for prototyping. For production, compile the CSS with the Tailwind CLI and self-host Chart.js.

## Structure

```
index.html            UI markup
assets/css/app.css    print and scrollbar styles
assets/js/calc.js     pure valuation, formatting and date logic (unit-tested)
assets/js/data.js     demo seed data (5 projects, 10 contractor packages)
assets/js/app.js      state, persistence, rendering, actions
tests/calc.test.js    node:test unit tests
```
