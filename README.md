# ASCTO — Interim Payment Certificate (IPC) System

A browser app for preparing, checking and approving FIDIC-style Interim Payment Certificates across multiple projects and contractor packages.

## Run it

No build step and no dependencies. Serve the folder with any static server, for example:

```bash
npx http-server -p 8080 .
# then open http://localhost:8080
```

Opening `index.html` directly from disk also works. External assets come from CDNs: Tailwind Play CDN, Chart.js 4.4.1 (jsDelivr) and Google Fonts.

## Hosted viewing page (claude.ai Artifact)

`python3 tools/build_artifact.py OUT_DIR` writes the page in the Artifact host's format (no `<html>`/`<head>`/`<body>` wrappers), and the `assets/` files are published alongside it. Inside that viewer, confirmations use in-page dialogs, the Excel certificate and JSON backup are saved through the viewer's save confirmation (`downloads` capability), and the Print buttons are hidden because the viewer cannot open a print dialog. Data stays in each viewer's own browser; it is not shared between people.

## Official certificate template

The certificate follows the client's **CONTRACTOR PAYMENT CERTIFICATE** workbook (`IPC - 1.xlsx`, sheet `IPC-000-000`, A1:M62):

- **IPC Certificate tab**: an on-screen and printable replica with the same rows, line numbers, merges and three columns (Last Period / This Period / Cumulative / Remarks).
- **Download Excel (Official Template)**: fills a cleaned copy of the workbook (`assets/templates/ipc-template.xlsx`) using ExcelJS 4.4.0 (vendored in `assets/vendor/`, loaded on first export). Dates are written as real Excel dates and the VAT number as text.
- Both outputs are built from one model (`assets/js/certificate.js`), so they cannot disagree.

Cleaning the template: `python3 tools/clean_template.py "IPC - 1.xlsx"`, then `python3 tools/embed_template.py`. The cleaning step:
- removes ~19,600 legacy defined names and 9 external workbook links (these caused Excel's "update links" prompt and made the file 700 KB; it is now 15 KB)
- widens THIS PERIOD and CUMULATIVE so 9-digit SAR amounts don't print as `####`
- fixes two label typos

### Payment chain (as laid out in the template)

| Line | Meaning |
|---|---|
| 01 = 01.1 + 01.2 | Material on site (MIR, at valuation %) + measured BOQ work (WIR) |
| 02, 03, 04, 05, 06 | Reimbursables, approved variations, advance paid (IPC-00), retention released, VAT adjustment |
| **A** | Total gross to date |
| 06–09 | Advance recovery (capped at advance paid), retention (capped), liquidated damages, other deductions |
| **B** | Total deductions to date |
| 10 / 11 / **C** | Previous IPC payments (= previous A − B, less previous other payments) / other payments / total |
| 12 | VAT on (A − B − C). The VAT adjustment line is not taxed again. |
| Payment due | (A − B − C) + VAT |
| 13.1 | Deduction after VAT (this certificate only) |
| **Net payment due** | Payment due − 13.1 (shown in words) |

### Sign-off

Sign-off follows the template's signature blocks, in order: Consultant site office → Employer site office → Employer home office. Signatories and the employer name are editable under **Signatories**. Changing any valuation figure after a sign-off clears all sign-offs, and the next IPC can only be opened after all three tiers have signed. A new package with an advance starts at **IPC-00** (advance payment certificate).

## Tests

The valuation engine, certificate model and Excel fill are unit-tested with Node's built-in test runner (Node 18+):

```bash
npm test                                        # node --test tests/*.test.js
npm i --no-save exceljs@4.4.0 && npm test       # also runs the Excel template round-trip test
```

## Features

- **Contractors hub**: consolidated commitments, certified value, retention and current net due per project, with sector filters and a cross-valuation matrix.
- **IPC certificate**: replica of the official template (Last Period / This Period / Cumulative), amount in words, signature blocks, print and Excel export.
- **BOQ valuation**: inline "this period" quantities, search, and overrun flags (▲) when the cumulative quantity exceeds the contract quantity.
- **Variations**: approved or pending VOs with previous % and % to date. Only approved VOs affect the revised sum.
- **Materials on site (MOS)**: previous and current stored quantities at the contractual valuation %. A drawdown produces a negative period movement.
- **Deductions**: retention (rate and cap), advance recovery (rate, capped at advance paid), and other deductions (NCR / penalties).
- **Payment ledger**: per-IPC movements, with a "Mark Paid" step for certified certificates.
- **Approvals workflow**: three-tier sign-off per the template, or Return with a reason. Every action goes into an audit trail per contractor.
- **Adjustments**: template lines not measured from the BOQ (02, 04, 05, 06, 08, 09, 11, 13.1), entered per period.
- **New IPC cycle**: blocked until all sign-offs are in. On rollover it locks quantities, VO %, MOS and adjustments as "last period", writes the ledger row, and advances the period and dates.
- **Analytics**: S-curve and per-IPC net payable charts, built from the ledger.
- **Persistence**: saved automatically to `localStorage`, with JSON **Backup / Restore** and **Reset Demo** to restore the seed data.

## Calculation rules (`calc.js`)

| Line | Rule |
|---|---|
| Work value | BOQ (prev + this qty) × rate + approved VOs × % + MOS qty × rate × valuation % (drives progress, retention and advance recovery) |
| Retention | `retentionRate` × (BOQ + VO), capped at `retentionCapRate` × revised contract sum. MOS is excluded. |
| Advance recovery | `advanceRecoveryRate` × work value, capped at the advance paid |
| VAT | `vatRate` × (A − B − C), excluding the VAT adjustment line (default 15%) |
| Period | Always **cumulative − last period** for every line, so every column reconciles |

## Known limitations (read before real use)

- **Template rules were inferred, not given.** The workbook has no formulas. Check the payment chain table above against your Particular Conditions, especially line 10, the treatment of the VAT adjustment, and the use of the THIS PERIOD column for the due rows.
- **Single-user, browser-local data.** No server, authentication or role separation. Anyone using the browser can approve. Data lives in that one browser's `localStorage`.
- **Seeded history is synthetic.** For the demo contractors, the earlier IPC ledger rows are generated so that they sum to the "Previous Certified" figures. They are not real records.
- **The S-curve baseline is indicative.** It is a logistic curve over the project dates, not a programme baseline.
- **Tailwind Play CDN** is intended for prototyping. For production, compile the CSS with the Tailwind CLI and self-host Chart.js.

## Structure

```
index.html            UI markup
assets/css/app.css    print and scrollbar styles
assets/js/calc.js     pure valuation, formatting and date logic (unit-tested)
assets/js/certificate.js  certificate model mapped onto the official template rows
assets/js/export-xlsx.js  fills the Excel template (ExcelJS)
assets/templates/     cleaned official template (.xlsx) + base64 copy used by the browser
assets/vendor/        ExcelJS 4.4.0 browser build
tools/                template cleaning / embedding scripts
assets/js/data.js     demo seed data (5 projects incl. Crystal Gallery Mall, the default; 10 contractor packages)
assets/js/app.js      state, persistence, rendering, actions
tests/                node:test unit tests (calc, certificate, Excel export)
```
