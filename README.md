# ASTCO 4D Planner

Single-file 4D BIM + CPM project planning tool (`index.html`). Open it in a browser; no build step.

Dependencies (loaded from CDN): Tailwind CSS Play CDN v3, Three.js r128 (cdnjs). If Three.js fails to load, the
3D pane shows a notice and everything else keeps working.

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

## Known simplifications
- Calendars are labels only. All durations count on a single project-day timeline.
- No P6 XER/XML export. The previous stubs did not produce files P6 can import, so they were removed rather than kept as fakes.
