/*
 * Midad Executive Suite — portfolio dataset.
 * All money values are SAR millions. Illustrative data for demonstration.
 *
 * Model rules (enforced by engine.integrityChecks):
 *   Σ package.budget + (contingency.original − contingency.drawn) = bac
 *   Σ monthlyBaseline = bac
 *   Σ monthlyActual   = Σ commitment.certified   (gross certified cost to date)
 *   package.budget is the *current* budget: original allocation plus approved
 *   transfers from contingency (contingency.drawn).
 *   package.pct / planPct are physical % complete (actual / planned at data date).
 *   Risk impacts are unmitigated and NOT included in package EAC.
 */
(function (root) {
  const DATA = {
    reportingPeriod: '2026-09',
    retentionRate: 0.05,
    projects: [
      {
        id: 'p1', code: 'JWT', name: 'Jeddah Waterfront Towers', sector: 'Mixed-use real estate',
        sponsor: 'Real Estate Development', pm: 'PMO — Western Region',
        bac: 142.5, start: '2026-04', debtShare: 0.6, prelimPerMonth: 0.32,
        contingency: { original: 10.0, drawn: 3.6 },
        packages: [
          { code: 'SUB', name: 'Substructure & Foundations', budget: 25.0, eac: 25.0, pct: 0.98, planPct: 1.00 },
          { code: 'SUP', name: 'Superstructure Frame', budget: 49.2, eac: 49.9, pct: 0.50, planPct: 0.55 },
          { code: 'MEP', name: 'MEP Infrastructure', budget: 33.2, eac: 34.1, pct: 0.16, planPct: 0.20 },
          { code: 'FAC', name: 'Facade & Curtain Wall', budget: 19.5, eac: 19.62, pct: 0.20, planPct: 0.22 },
          { code: 'PMO', name: 'Consultants & PMO', budget: 9.2, eac: 9.4, pct: 0.62, planPct: 0.60 }
        ],
        commitments: [
          { id: 'C-101', title: 'Deep Piling & Dewatering Works', vendor: 'Bauer Foundations', pkg: 'SUB', original: 24.5, variations: 0.45, certified: 24.1, status: 'Active' },
          { id: 'C-102', title: 'Core & Slab Reinforced Concrete', vendor: 'Arabian Construction Co', pkg: 'SUP', original: 48.0, variations: 0.9, certified: 22.4, status: 'Active' },
          { id: 'C-103', title: 'HVAC & High Voltage Package', vendor: 'Drake & Scull Tech', pkg: 'MEP', original: 21.5, variations: 0.12, certified: 4.8, status: 'Under Review' },
          { id: 'C-104', title: 'Double-Glazed Facade Cladding', vendor: 'Schüco Gulf Solutions', pkg: 'FAC', original: 14.24, variations: 0, certified: 3.52, status: 'Active' },
          { id: 'C-105', title: 'Engineer & PMO Services', vendor: 'Gulf PMO Consultants', pkg: 'PMO', original: 9.0, variations: 0, certified: 5.4, status: 'Active' }
        ],
        risks: [
          { id: 'R-14', title: 'Piling obstruction & geotechnical variance (CO #14)', owner: 'Package Manager — Civil', p: 0.60, min: 0.5, ml: 0.85, max: 1.4, delayWeeks: 2, mitigation: 'Pre-drilling probe programme; agree rate with Bauer before mobilisation' },
          { id: 'R-09', title: 'Curtain wall unit supply-chain delay', owner: 'Procurement Lead', p: 0.35, min: 0.3, ml: 0.8, max: 1.8, delayWeeks: 6, mitigation: 'Second-source glass; expedite shop drawings' },
          { id: 'R-11', title: 'MEP balance tender escalation (SAR 11.7M uncommitted)', owner: 'Commercial Manager', p: 0.50, min: 0.4, ml: 1.0, max: 2.2, delayWeeks: 0, mitigation: 'Award before Q1-27 copper price review' }
        ],
        monthlyBaseline: [2.4, 4.6, 7.3, 10.9, 14.1, 15.6, 15.1, 13.6, 12.2, 10.7, 9.3, 7.8, 6.3, 4.4, 3.4, 2.0, 1.6, 1.2],
        monthlyActual: [2.6, 5.0, 8.6, 12.6, 15.2, 16.22]
      },
      {
        id: 'p2', code: 'ANL', name: 'Al-Narjis Logistics Park', sector: 'Industrial & logistics',
        sponsor: 'Logistics Ventures', pm: 'PMO — Central Region',
        bac: 68.0, start: '2026-05', debtShare: 0.6, prelimPerMonth: 0.15,
        contingency: { original: 5.0, drawn: 1.2 },
        packages: [
          { code: 'GRD', name: 'Grading & Heavy Paving', budget: 18.2, eac: 18.2, pct: 0.95, planPct: 0.95 },
          { code: 'STL', name: 'Pre-Engineered Steel Frames', budget: 26.4, eac: 26.8, pct: 0.48, planPct: 0.52 },
          { code: 'CLD', name: 'Cold Storage & MEP', budget: 15.6, eac: 16.4, pct: 0.22, planPct: 0.30 },
          { code: 'EXT', name: 'External Works & Utilities', budget: 4.0, eac: 4.0, pct: 0.05, planPct: 0.10 }
        ],
        commitments: [
          { id: 'L-201', title: 'Industrial Flooring & Civil Works', vendor: 'Al-Latifia Trading & Contracting', pkg: 'GRD', original: 18.0, variations: 0.2, certified: 17.2, status: 'Active' },
          { id: 'L-202', title: 'Structural Steel Portals & Roofing', vendor: 'Zamil Steel Structures', pkg: 'STL', original: 26.0, variations: 0.4, certified: 12.4, status: 'Active' },
          { id: 'L-203', title: 'Cold Store Refrigeration & MEP', vendor: 'Arctic Gulf MEP', pkg: 'CLD', original: 11.0, variations: 0, certified: 3.4, status: 'Under Review' }
        ],
        risks: [
          { id: 'R-03', title: 'Refrigeration plant lead time', owner: 'Package Manager — MEP', p: 0.45, min: 0.3, ml: 0.6, max: 1.2, delayWeeks: 4, mitigation: 'Release long-lead order ahead of full design freeze' },
          { id: 'R-05', title: 'Utility (power) connection delay', owner: 'Authorities Liaison', p: 0.40, min: 0.1, ml: 0.3, max: 0.6, delayWeeks: 8, mitigation: 'Temporary generation option priced as fallback' }
        ],
        monthlyBaseline: [4.0, 6.5, 9.0, 10.5, 9.5, 8.0, 6.5, 5.0, 4.0, 2.5, 1.5, 1.0],
        monthlyActual: [3.9, 6.4, 8.6, 7.6, 6.5]
      },
      {
        id: 'p3', code: 'MRH', name: 'Metropolitan Residential Hub', sector: 'Residential',
        sponsor: 'Residential Communities', pm: 'PMO — Central Region',
        bac: 85.0, start: '2026-06', debtShare: 0.6, prelimPerMonth: 0.20,
        contingency: { original: 6.0, drawn: 0.8 },
        packages: [
          { code: 'ENB', name: 'Enabling & Shoring', budget: 12.3, eac: 12.3, pct: 1.00, planPct: 1.00 },
          { code: 'TWR', name: 'Main Tower Structure', budget: 42.5, eac: 43.9, pct: 0.30, planPct: 0.26 },
          { code: 'FIT', name: 'Interior Architectural Fit-out', budget: 25.0, eac: 26.8, pct: 0.04, planPct: 0.06 }
        ],
        commitments: [
          { id: 'M-301', title: 'Secant Piles & Shoring Anchors', vendor: 'Keller Ground Engineering', pkg: 'ENB', original: 12.0, variations: 0.3, certified: 12.3, status: 'Complete' },
          { id: 'M-302', title: 'Tower Reinforced Cast Concrete', vendor: 'Nesma & Partners', pkg: 'TWR', original: 38.0, variations: 0.25, certified: 11.6, status: 'Active' },
          { id: 'M-303', title: 'Fit-out Early Works (Show Units)', vendor: 'Riyadh Interiors Co', pkg: 'FIT', original: 12.0, variations: 0, certified: 0.9, status: 'Active' }
        ],
        risks: [
          { id: 'R-21', title: 'Fit-out balance tender escalation (SAR 14.8M uncommitted)', owner: 'Commercial Manager', p: 0.65, min: 0.8, ml: 1.6, max: 3.0, delayWeeks: 0, mitigation: 'Split package; frame agreement for finishes' },
          { id: 'R-22', title: 'Tower crane availability / wind downtime', owner: 'Construction Manager', p: 0.25, min: 0.2, ml: 0.5, max: 1.0, delayWeeks: 3, mitigation: 'Second crane option held' }
        ],
        monthlyBaseline: [3.0, 5.5, 8.0, 9.5, 11.0, 10.0, 8.5, 7.5, 6.5, 5.5, 4.0, 3.0, 2.0, 1.0],
        monthlyActual: [3.1, 5.6, 7.6, 8.5]
      },
      {
        id: 'p4', code: 'NGS', name: 'NEOM Green Energy Grid Substation', sector: 'Energy & utilities',
        sponsor: 'Energy Infrastructure', pm: 'PMO — Northern Region',
        bac: 210.0, start: '2026-04', debtShare: 0.6, prelimPerMonth: 0.45,
        contingency: { original: 18.0, drawn: 4.2 },
        packages: [
          { code: 'CIV', name: 'Site Levelling & Heavy Civil', budget: 35.5, eac: 35.5, pct: 0.93, planPct: 0.95 },
          { code: 'GIS', name: 'GIS Switchgear & Transformers', budget: 97.0, eac: 101.8, pct: 0.42, planPct: 0.50 },
          { code: 'SCA', name: 'Control Systems & SCADA', budget: 42.7, eac: 45.9, pct: 0.18, planPct: 0.30 },
          { code: 'OHL', name: 'Overhead Transmission Lines', budget: 21.0, eac: 22.4, pct: 0.10, planPct: 0.20 }
        ],
        commitments: [
          { id: 'N-401', title: 'Civil Foundations for Substations', vendor: 'Al-Bawani Group', pkg: 'CIV', original: 35.0, variations: 0.5, certified: 33.0, status: 'Active' },
          { id: 'N-402', title: 'Gas Insulated Switchgear 380kV', vendor: 'Hitachi Energy Gulf', pkg: 'GIS', original: 95.0, variations: 1.8, certified: 44.0, status: 'Active' },
          { id: 'N-403', title: 'SCADA & Protection Systems', vendor: 'Gulf Automation Systems', pkg: 'SCA', original: 31.0, variations: 0, certified: 8.6, status: 'Under Review' },
          { id: 'N-404', title: '380kV Overhead Line Stringing', vendor: 'Desert Line Transmission', pkg: 'OHL', original: 18.0, variations: 0, certified: 2.4, status: 'Active' }
        ],
        risks: [
          { id: 'R-31', title: 'Transformer factory acceptance test failure / re-test', owner: 'Package Manager — Electrical', p: 0.30, min: 1.0, ml: 2.5, max: 5.0, delayWeeks: 10, mitigation: 'Witness pre-FAT; hold slot for re-test' },
          { id: 'R-32', title: 'SCADA integration scope gap with grid operator', owner: 'Systems Integration Lead', p: 0.55, min: 1.0, ml: 2.0, max: 4.0, delayWeeks: 6, mitigation: 'Joint interface workshop; freeze ICD by Nov-26' },
          { id: 'R-33', title: 'Extreme-heat productivity loss (summer works)', owner: 'Construction Manager', p: 0.70, min: 0.4, ml: 0.9, max: 1.6, delayWeeks: 4, mitigation: 'Night-shift programme for OHL stringing' }
        ],
        monthlyBaseline: [4.0, 8.0, 14.0, 18.0, 22.0, 24.0, 23.0, 21.0, 18.0, 15.0, 12.0, 10.0, 8.0, 6.0, 4.0, 3.0],
        monthlyActual: [4.1, 7.9, 14.0, 17.6, 20.8, 23.6]
      }
    ],
    /*
     * Projects built at load time from another ASTCO app's data feed (see assets/adapters.js).
     * Only management metadata lives here; prices, phasing and contingency come from the feed.
     */
    /*
     * The other ASTCO apps. Branches live in this repository; URLs are the published pages.
     * Viewers can override a URL in the Connected apps view (stored in their own browser only).
     */
    apps: [
      { id: 'planner', name: 'ASTCO 4D Planner', role: 'Schedule, CPM & cost-loaded baseline', branch: 'claude/fervent-euler-lqew8l',
        url: 'https://claude.ai/artifact/5MM7PA32R4MZBHjaPx4NX7',
        feeds: 'Monthly cash-flow CSV (Data → Monthly cash flow) → replaces a project\'s baseline profile', mode: 'File import' },
      { id: 'takeoff', name: 'Crystal Gallery 4D/5D Take-off', role: 'Quantities, priced BoQ & scope-gap register', branch: 'claude/stoic-hypatia-456ykd',
        url: 'https://claude.ai/artifact/2tqcb27PQu8xh6TrKJ5qNM',
        feeds: 'Priced bill → Crystal Gallery budget, phasing & contingency (via the shared costing feed); scope gaps → risk register', mode: 'Linked feed' },
      { id: 'ipc', name: 'ASCTO IPC System', role: 'Interim payment certificates (FIDIC)', branch: 'claude/ascto-ipc-system-app-73nzq4',
        url: 'https://claude.ai/artifact/9x6PnPDCARyRj4NcPCYHmq',
        feeds: 'Consumes the same costing feed (contract sum SAR 326,769,832). Certified-to-date figures → commitments via midad-feed/1 JSON', mode: 'Shared feed + JSON' },
      { id: 'procurement', name: 'ASTCO Procurement & Logistics', role: 'RFQs, vendor quotes & awards', branch: 'claude/procurement-logistics-app-96m7s3',
        url: '',
        feeds: 'Awarded RFQs → commitments. Not automated: the server has no export endpoint yet; use midad-feed/1 JSON', mode: 'Self-hosted server' }
    ],
    linkedProjects: [
      {
        feed: 'crystal-gallery-costing',
        meta: {
          id: 'p5', code: 'CGJ', name: 'Crystal Gallery Mall, Jeddah', sector: 'Retail & leisure',
          sponsor: 'Retail Development', pm: 'PMO — Western Region', stage: 'Pre-construction (NTP Mar-27)',
          debtShare: 0.6,
          prelimPerMonth: 0.6, // ASSUMPTION: time-related preliminaries per month of delay; confirm with QS
          risks: [
            // Figures from the take-off scope-gap register (branch claude/stoic-hypatia-456ykd, commit f0222a5).
            // The priced bill (and therefore BAC) excludes them. Probabilities and ranges are assumptions.
            { id: 'G-01', title: 'Fire & life-safety MEP scope not in priced bill (QS to confirm)', owner: 'Cost Manager / QS', p: 0.50, min: 12.0, ml: 16.4, max: 20.0, delayWeeks: 0, mitigation: 'Confirm FLS scope against MEP rough-in lines before tender' },
            { id: 'G-02', title: 'Cinema equipment supply — operator lease undecided', owner: 'Leasing Director', p: 0.50, min: 19.6, ml: 20.6, max: 21.6, delayWeeks: 0, mitigation: 'Settle operator-supply clause in cinema lease heads of terms' },
            { id: 'G-03', title: 'Common-area FF&E and signage allowances', owner: 'Design Manager', p: 0.90, min: 4.0, ml: 5.0, max: 6.0, delayWeeks: 0, mitigation: 'Carry as provisional sums in tender' }
          ]
        }
      }
    ]
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
  else root.MIDAD_DATA = DATA;
})(typeof window !== 'undefined' ? window : globalThis);
