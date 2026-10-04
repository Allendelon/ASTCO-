# ASTCO 4D Planner

Single-file 4D BIM + CPM project planning tool (`index.html`). Open it in a browser; no build step.

Dependencies (loaded from CDN): Tailwind CSS Play CDN v3, Three.js r128 (cdnjs). If Three.js fails to load, the
3D pane shows a notice and everything else keeps working.

## Projects
- **CG-JED: Crystal Gallery, Jeddah** (default). Generated from *concept i — Revised Design Submission 2 (27 Jan 2023)*.
  It has 48 activities over B2–L4. Quantities come from the Schedule of Areas (PDF p.17) and floor heights from the elevations and sections.
- **PRJ-101: High-Rise Tower** (sample used to demonstrate progress tracking).

## Drawing → schedule → cost & resources (no P6 needed)
Each Crystal Gallery activity carries a quantity basis (Quantities tab). Edit any value and every date, cost and curve updates:
- duration = quantity ÷ (productivity per crew-day × crews)
- budget = quantity × unit rate, split into labour / plant / materials / indirect by trade
- manpower = crews × men per crew; plant = crews × plant per crew
- each activity also lists the drawings it is built from

**Drawing schedule** (Drawings tab): for each drawing, the date IFC is required = earliest start of the activities that use it − IFC lead (45 days by default).
Click a drawing to filter the Gantt to the work that depends on it.

**Exports for integration** (Data menu): cost-loaded schedule, monthly cash flow, manpower by trade per month, and the drawing schedule
as CSV, plus the full project as JSON for re-import.

**What is assumed, not taken from the drawings:** unit rates (SAR), productivities, crew sizes, basement storey heights (3.6 m),
lump sums, and quantities measured off plans/elevations (shoring, facade, roofing, lift counts, external works). Each one is labelled
in its "Quantity source" field. Replace them with QS and contractor data before using the budget or durations.

## What the engine actually does
- **CPM with a data date (progress override):** completed work keeps its actual dates; in-progress work finishes at
  Data Date + Remaining Duration; unstarted work cannot start before the Data Date. FS/SS/FF/SF with lags,
  loop detection, optional "must finish by" (allows negative float), and a configurable critical float threshold.
- **% complete types:** Physical (rolled up from weighted steps, or entered manually when step roll-up is off),
  Duration ((OD−RD)/OD), and Units (actual / (actual + remaining) labor hours). Performance % follows the type and
  drives Earned Value.
- **The 4D cursor and the Data Date are separate.** Scrubbing the timeline does not re-status the schedule.
- **EVM:** PV from the selected baseline (BL0/BL1/BL2), EV = Σ BAC × Perf %, AC as entered, plus SPI/CPI/EAC/TCPI/VAC.
  Store Period Performance snapshots the history plotted on the S-curve.
- **Resource leveling:** daily labor/plant loads come from each activity's crew and plant rates. Leveling delays only
  unstarted, non-critical activities within their total float. It never extends the finish date and reports any
  overloads it could not resolve.
- Editable activities, steps, relationships, actual dates, costs and resources; data is saved to localStorage; CSV/JSON export and JSON import.

## Location-based views (after ConstructIQ "Construction in Motion")
- **Viewing date** (orange) drives every view; the **data date** (amber) is the status cutoff. Play / −7d / +7d / go-to-date,
  speed, "Follow work", jump buttons (Foundations, Structure, Envelope, Fit-out, Data date, Handover), drag the Gantt sideways.
- **KPI strip:** levels structurally complete, floors handover-ready, and topping-out / permanent-power / handover
  forecasts against the selected baseline.
- **Elevation:** each floor is coloured by the last trade it has completed, and window bays fill as the current trade progresses. Click a floor to filter the Gantt.
- **Floor sequence:** a location × trade matrix showing % and done/total at the viewing date, plus each floor's forecast ready date.
- **Compare:** any two of BL0 / BL1 / BL2 / current. Shows milestone movement and per-activity finish slip.
- Each activity carries a trade `phase` and a `floors` range (0 = foundation, 21 = roof), editable on the General tab.

Progress on dates other than the data date is **illustrative**. It is interpolated from start to the recorded status,
then forecast linearly to the finish, with floors worked bottom-up. It is not measured progress.

## Known simplifications
- Calendars are labels only. All durations count on a single project-day timeline.
- No P6 XER/XML export. The previous stubs did not produce files P6 can import, so they were removed rather than kept as fakes.
