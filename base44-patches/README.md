# Pending Base44 changes

Changes for the live Base44 app (`ASTCO Procurement & Logistics`) that were built and
verified but not yet deployed.

## cost-summary-by-discipline.patch

Adds **Cost Summary & Value Added by Discipline** to the Control Tower:
budget, committed PO value, value added vs budget (savings %, overruns in red),
value added by competition (average valid quote minus awarded price, RFQs with 2+ bids),
and open pipeline, per discipline with a total row. Sums one currency (SAR);
other currencies are reported as excluded, never added in.

Touches `src/lib/procurement.js` and `src/pages/procurement/ControlTower.jsx`.
Made against Base44 commit `a7021ec`. Apply from the Base44 app root:

    git apply cost-summary-by-discipline.patch

Test the calculation (copy the patched `src/lib/procurement.js` to a `.mjs` file first):

    LIB=/path/to/procurement.mjs node --test cost-summary.test.mjs
