# ASTCO-

## Crystal Gallery take-off & 5D cost model

`crystal-gallery-takeoff.html` is a single-file interactive take-off, BoQ, 4D schedule and cashflow model for Crystal Gallery, Jeddah. It is built from Concept i Design's Revised Design Submission 2 (27 Jan 2023). Open it in a browser. It loads Tailwind and Font Awesome from CDNs.

- Measurement base: schedule of areas (p.17) and floor-to-floor heights (elevations/sections).
- Every BoQ line is flagged DRW (from drawing), DER (derived with an assumption) or ALW (allowance).
- Class 4 estimate (−20%/+30%). Rates are indicative SAR placeholders. Override them in the Controls lens.
- 4D BIM planning: location breakdown structure (pour zones per level), zone-level tasks under each frame activity, line-of-balance sweeps for MEP/finishes/facade, plan view with indicative site logistics, weekly time-space clash checks, a manpower histogram, a 3-week look-ahead, and a TimeLiner-style element↔task link table (CSV export) that reconciles to the BoQ direct cost.
- Default cost basis = the ASTCO 4D Planner (branch `claude/fervent-euler-lqew8l`, project CG-JED), imported line for line: base SAR 298,452,170 → out-turn SAR 326,769,832 (5%/yr escalation to each line's cost midpoint) → SAR 343,108,324 with the 5% contingency reserve, excl. VAT. The original elemental take-off stays selectable ("Elemental QTO") and the Cost Plan tab reconciles the two by element.
