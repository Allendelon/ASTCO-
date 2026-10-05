/*
 * ASCTO IPC — demo seed data.
 * Loaded once on first run (or on "Reset Demo"); afterwards state lives in localStorage.
 * Prior-IPC ledger history and audit entries are generated in app.js from these figures so
 * that the ledger always sums to the "Previous Certified" column.
 */
window.IPC_SEED = {
  // Project the app opens on for a new viewer (and after Reset Demo).
  defaultProject: 'p4',
  approver: { name: 'Eng. Abdullah Al-Otaibi', role: 'Director of Commercial Operations' },
  projects: {
    p1: {
      id: 'p1',
      name: 'ASCTO Red Sea Mixed-Use Tower & Podium - Jeddah',
      sector: 'Mixed-Use',
      client: 'ASCTO Mixed-Use Development Co.',
      consultant: 'Dar Al-Handasah Engineering Consultants',
      engineerName: 'Dr. Khaled Mansour, PMP',
      engineerRole: 'Lead Resident Engineer',
      commenceDate: '15 Jan 2025',
      completeDate: '15 Jul 2027',
      activeContractorId: 'c1_mix1',
      contractors: [
        {
          id: 'c1_mix1',
          companyName: 'Saudi Binladin Construction Group',
          package: 'Main Civil, Podium Structure & Retail Shell',
          sector: 'Mixed-Use',
          tradeCategory: 'Mixed-Use: Podium & Multi-tenant Core',
          contractRef: 'ASCTO-MXD-JED-PKG-01',
          repName: 'Eng. Tariq Al-Ghamdi',
          repRole: 'Project Commercial Manager',
          originalContractSum: 135000000,
          advancePaymentOriginal: 13500000,
          advanceRecoveryRate: 0.10,
          retentionRate: 0.10,
          retentionCapRate: 0.05,
          vatRate: 0.15,
          currentIpcNo: 'IPC-07',
          valuationPeriod: '01 Sep 2026 to 25 Sep 2026',
          issueDate: '28 Sep 2026',
          approvalStatus: 'Under Review',
          otherDeductionsToDate: 150000,
          otherDeductionsPrev: 150000,
          boqItems: [
            { id: 1, code: '01.00', desc: 'Preliminaries & Mixed-Use Logistics Coordination', unit: 'LS', rate: 8500000, contractQty: 1, prevQty: 0.60, thisQty: 0.05 },
            { id: 2, code: '02.10', desc: 'Deep Basement Excavation & 4-Level Substructure', unit: 'm3', rate: 75, contractQty: 95000, prevQty: 95000, thisQty: 0 },
            { id: 3, code: '03.10', desc: 'Podium Transfer Slabs & Retail Anchor Superstructure', unit: 'm3', rate: 880, contractQty: 32000, prevQty: 24000, thisQty: 2800 },
            { id: 4, code: '03.20', desc: 'Post-Tensioned Tower Floor Plates (Levels 5-42)', unit: 'm2', rate: 360, contractQty: 84000, prevQty: 42000, thisQty: 6500 }
          ],
          variations: [
            { id: 1, code: 'VO-01', desc: 'Podium mezzanine expansion for fine-dining terrace', date: '14 May 2025', approvedSum: 1450000, prevPct: 60, progressPct: 90, status: 'Approved' }
          ],
          mos: [
            { id: 1, code: 'MOS-01', desc: 'Structural Steel Truss Members for Podium Atrium', unit: 'Ton', prevQty: 250, qty: 380, invoiceRate: 5200, certPct: 75 }
          ]
        },
        {
          id: 'c1_mix2',
          companyName: 'Al-Bawani Electromechanical Co.',
          package: 'Podium Central Logistics, Loading Docks & MEP',
          sector: 'Mixed-Use',
          tradeCategory: 'Mixed-Use: Central Logistics & Loading Docks',
          contractRef: 'ASCTO-MXD-JED-PKG-02',
          repName: 'Eng. Ziyad Al-Harbi',
          repRole: 'Senior Commercial Director',
          originalContractSum: 58000000,
          advancePaymentOriginal: 5800000,
          advanceRecoveryRate: 0.10,
          retentionRate: 0.10,
          retentionCapRate: 0.05,
          vatRate: 0.15,
          currentIpcNo: 'IPC-05',
          valuationPeriod: '01 Sep 2026 to 25 Sep 2026',
          issueDate: '27 Sep 2026',
          approvalStatus: 'Approved',
          otherDeductionsToDate: 0,
          otherDeductionsPrev: 0,
          boqItems: [
            { id: 1, code: '05.10', desc: 'Subterranean Loading Dock Automation & Scissor Lifts', unit: 'Sets', rate: 450000, contractQty: 8, prevQty: 3, thisQty: 2 },
            { id: 2, code: '05.20', desc: 'Mixed-Use Multi-Zone Smoke Evacuation & Pressurization', unit: 'LS', rate: 16500000, contractQty: 1, prevQty: 0.40, thisQty: 0.12 },
            { id: 3, code: '05.30', desc: 'Retail & Residential Dual-Feed Electrical Substations', unit: 'Sets', rate: 1850000, contractQty: 6, prevQty: 2, thisQty: 1 }
          ],
          variations: [
            { id: 1, code: 'VO-01', desc: 'Addition of refrigerated garbage compaction chambers', date: '10 Jun 2026', approvedSum: 780000, prevPct: 55, progressPct: 80, status: 'Approved' }
          ],
          mos: [
            { id: 1, code: 'MOS-01', desc: 'Motorized Industrial Fire Damper Consignment', unit: 'Sets', prevQty: 80, qty: 120, invoiceRate: 4200, certPct: 75 }
          ]
        }
      ]
    },
    p2: {
      id: 'p2',
      name: 'ASCTO King Salman District Cooling & RO Plant - Riyadh',
      sector: 'Plants & Utilities',
      client: 'ASCTO Infrastructure & Utilities Ltd.',
      consultant: 'KEO International Utilities Division',
      engineerName: 'Eng. Omar Fadel',
      engineerRole: 'Resident Utilities Engineer',
      commenceDate: '01 Feb 2025',
      completeDate: '30 Nov 2026',
      activeContractorId: 'c2_plt1',
      contractors: [
        {
          id: 'c2_plt1',
          companyName: 'Tabreed National Utilities Contracting',
          package: '45,000 TR District Cooling Plant & Chillers',
          sector: 'Plants & Utilities',
          tradeCategory: 'Plants: District Cooling Plant (DCP)',
          contractRef: 'ASCTO-PLT-RUH-DCP-01',
          repName: 'Eng. Marwan Khoury',
          repRole: 'Utilities Project Director',
          originalContractSum: 165000000,
          advancePaymentOriginal: 16500000,
          advanceRecoveryRate: 0.10,
          retentionRate: 0.10,
          retentionCapRate: 0.05,
          vatRate: 0.15,
          currentIpcNo: 'IPC-06',
          valuationPeriod: '01 Sep 2026 to 25 Sep 2026',
          issueDate: '29 Sep 2026',
          approvalStatus: 'Approved',
          otherDeductionsToDate: 0,
          otherDeductionsPrev: 0,
          boqItems: [
            { id: 1, code: 'PLT.01', desc: 'Centrifugal Water-Cooled Chillers (3,500 TR Each)', unit: 'Units', rate: 5800000, contractQty: 10, prevQty: 6, thisQty: 2 },
            { id: 2, code: 'PLT.02', desc: 'Induced Draft Cooling Towers with Variable VFDs', unit: 'Cells', rate: 1200000, contractQty: 12, prevQty: 7, thisQty: 3 },
            { id: 3, code: 'PLT.03', desc: 'Primary & Secondary Variable Flow Chilled Water Pumps', unit: 'Sets', rate: 480000, contractQty: 16, prevQty: 8, thisQty: 4 },
            { id: 4, code: 'PLT.04', desc: 'Thermal Energy Storage (TES) Concrete Tank (45,000 m3)', unit: 'LS', rate: 26000000, contractQty: 1, prevQty: 0.75, thisQty: 0.15 }
          ],
          variations: [
            { id: 1, code: 'VO-01', desc: 'Upgrade Chiller Heat Exchangers to Titanium for longevity', date: '15 Jan 2026', approvedSum: 2800000, prevPct: 100, progressPct: 100, status: 'Approved' }
          ],
          mos: [
            { id: 1, code: 'MOS-01', desc: 'Pre-Insulated Carbon Steel Header Pipes (DN900)', unit: 'm', prevQty: 800, qty: 1200, invoiceRate: 2400, certPct: 75 }
          ]
        },
        {
          id: 'c2_plt2',
          companyName: 'Veolia Water & Infrastructure KSA',
          package: 'RO Desalination & Sewage Effluent (STP) Plant',
          sector: 'Plants & Utilities',
          tradeCategory: 'Plants: Reverse Osmosis & STP Water Treatment',
          contractRef: 'ASCTO-PLT-RUH-WTR-02',
          repName: 'Eng. Hisham Al-Khatib',
          repRole: 'Process Plant Commercial Lead',
          originalContractSum: 88000000,
          advancePaymentOriginal: 8800000,
          advanceRecoveryRate: 0.10,
          retentionRate: 0.10,
          retentionCapRate: 0.05,
          vatRate: 0.15,
          currentIpcNo: 'IPC-04',
          valuationPeriod: '01 Sep 2026 to 25 Sep 2026',
          issueDate: '28 Sep 2026',
          approvalStatus: 'Under Review',
          otherDeductionsToDate: 45000,
          otherDeductionsPrev: 45000,
          boqItems: [
            { id: 1, code: 'RO.01', desc: 'Seawater / Brackish RO Membrane Pressure Vessels', unit: 'Skids', rate: 4200000, contractQty: 6, prevQty: 2, thisQty: 1.5 },
            { id: 2, code: 'RO.02', desc: 'Membrane Bioreactor (MBR) Effluent Recycling System', unit: 'LS', rate: 24000000, contractQty: 1, prevQty: 0.45, thisQty: 0.15 },
            { id: 3, code: 'RO.03', desc: 'Chemical Dosing & Chlorination Disinfection Skids', unit: 'Sets', rate: 780000, contractQty: 8, prevQty: 4, thisQty: 2 }
          ],
          variations: [],
          mos: [
            { id: 1, code: 'MOS-01', desc: 'High Pressure Duplex Stainless Steel Piping Racks', unit: 'LS', prevQty: 1, qty: 1, invoiceRate: 1850000, certPct: 75 }
          ]
        }
      ]
    },
    p3: {
      id: 'p3',
      name: 'ASCTO Al-Diriyah Luxury Oasis Resort & Spa - Diriyah',
      sector: 'Hospitality',
      client: 'ASCTO Hospitality & Tourism Assets',
      consultant: 'Jacobs Engineering & Interior Architecture',
      engineerName: 'Eng. Laila Haddad',
      engineerRole: 'Senior Resident Engineer',
      commenceDate: '01 May 2025',
      completeDate: '30 Dec 2027',
      activeContractorId: 'c3_hsp1',
      contractors: [
        {
          id: 'c3_hsp1',
          companyName: 'Depa Luxury Interiors & Millwork',
          package: '5-Star Hotel Guestrooms & Royal Suites ID Fit-Out',
          sector: 'Hospitality',
          tradeCategory: 'Hospitality: Luxury Hotel Interior Fit-out & Millwork',
          contractRef: 'ASCTO-HSP-DIR-PKG-01',
          repName: 'Eng. Salman Al-Dossary',
          repRole: 'Hospitality Works Director',
          originalContractSum: 94000000,
          advancePaymentOriginal: 9400000,
          advanceRecoveryRate: 0.10,
          retentionRate: 0.10,
          retentionCapRate: 0.05,
          vatRate: 0.15,
          currentIpcNo: 'IPC-04',
          valuationPeriod: '01 Sep 2026 to 25 Sep 2026',
          issueDate: '29 Sep 2026',
          approvalStatus: 'Approved',
          otherDeductionsToDate: 0,
          otherDeductionsPrev: 0,
          boqItems: [
            { id: 1, code: 'ID.01', desc: 'Presidential & Royal Suites Custom Najdi Woodwork', unit: 'Suites', rate: 950000, contractQty: 18, prevQty: 6, thisQty: 4 },
            { id: 2, code: 'ID.02', desc: 'Deluxe Guestrooms Acoustic Wall Paneling & Marble', unit: 'Keys', rate: 220000, contractQty: 180, prevQty: 65, thisQty: 30 },
            { id: 3, code: 'ID.03', desc: 'Grand Ballroom Hand-Tufted Wool Carpets & Chandeliers', unit: 'm2', rate: 3400, contractQty: 2400, prevQty: 800, thisQty: 600 }
          ],
          variations: [
            { id: 1, code: 'VO-01', desc: 'Acoustic upgrade to STC 58 for VIP Royal Bungalows', date: '18 Jun 2026', approvedSum: 1150000, prevPct: 60, progressPct: 85, status: 'Approved' }
          ],
          mos: [
            { id: 1, code: 'MOS-01', desc: 'Bookmatched Calacatta Gold Marble Slabs for Lobby', unit: 'm2', prevQty: 900, qty: 1500, invoiceRate: 1100, certPct: 75 }
          ]
        },
        {
          id: 'c3_hsp2',
          companyName: 'Al-Hokair Kitchens & Hospitality Systems',
          package: 'Main Production Kitchen, Bakery & Cold Rooms',
          sector: 'Hospitality',
          tradeCategory: 'Hospitality: Commercial Kitchens & Laundry Facilities',
          contractRef: 'ASCTO-HSP-DIR-PKG-02',
          repName: 'Eng. Mazen Haddad',
          repRole: 'Hospitality Project QS',
          originalContractSum: 32000000,
          advancePaymentOriginal: 3200000,
          advanceRecoveryRate: 0.10,
          retentionRate: 0.10,
          retentionCapRate: 0.05,
          vatRate: 0.15,
          currentIpcNo: 'IPC-03',
          valuationPeriod: '01 Sep 2026 to 25 Sep 2026',
          issueDate: '27 Sep 2026',
          approvalStatus: 'Under Review',
          otherDeductionsToDate: 0,
          otherDeductionsPrev: 0,
          boqItems: [
            { id: 1, code: 'KIT.01', desc: 'Heavy Duty Commercial Cooking Suites & Range Hoods', unit: 'Sets', rate: 1250000, contractQty: 6, prevQty: 2, thisQty: 1 },
            { id: 2, code: 'KIT.02', desc: 'Modular Walk-In Blast Freezers & Refrigerated Rooms', unit: 'Rooms', rate: 380000, contractQty: 14, prevQty: 6, thisQty: 3 },
            { id: 3, code: 'KIT.03', desc: 'Continuous Tunnel Washer Industrial Hotel Laundry', unit: 'LS', rate: 7400000, contractQty: 1, prevQty: 0.30, thisQty: 0.20 }
          ],
          variations: [],
          mos: [
            { id: 1, code: 'MOS-01', desc: '316 Stainless Steel Prep Tables & Sinks Consignment', unit: 'Sets', prevQty: 30, qty: 45, invoiceRate: 8500, certPct: 75 }
          ]
        }
      ]
    },
    p4: {
      id: 'p4',
      name: 'Crystal Gallery Mall',
      sector: 'Malls & Retail',
      // Source: Concept i Design, "Crystal Gallery — Revised Design Submission 2", 27 Jan 2023
      // (Jeddah; GFA 45,852 m²; 451 parking bays; 1,075-seat cinema; schedule of areas p.17).
      location: 'Jeddah, Saudi Arabia',
      designReference: 'Concept i Design — Revised Design Submission 2 (27 Jan 2023)',
      client: 'ASCTO',
      consultant: 'Concept i Design',
      engineerName: '',
      engineerRole: 'Project Manager',
      // Commencement/completion are overwritten from the linked cost model's programme on load.
      commenceDate: '01 Mar 2027',
      completeDate: '10 Aug 2028',
      activeContractorId: 'cg_main',
      contractors: [
        {
          id: 'cg_main',
          // BoQ, contract quantities, rates and the contract sum come from the Crystal Gallery cost model
          // (assets/js/crystal-gallery-costing.js, generated by tools/sync_costing.py). Do not hand-edit them here.
          linkedCosting: true,
          companyName: 'Main Contractor (to be appointed)',
          package: 'Main Works — Shell & Core incl. Cinema',
          sector: 'Malls & Retail',
          tradeCategory: 'Malls: Anchor Tenant Shell & Core Handover',
          contractRef: 'CG-JED-MC-01',
          repName: 'To be confirmed',
          repRole: 'Contractor Representative',
          advanceRate: 0.10,
          advanceRecoveryRate: 0.10,
          retentionRate: 0.10,
          retentionCapRate: 0.05,
          vatRate: 0.15,
          currentIpcNo: 'IPC-00',
          paymentType: 'Advance Payment',
          advancePaidPrev: 0,
          valuationPeriod: '01 Feb 2027 to 28 Feb 2027',
          issueDate: '28 Feb 2027',
          approvalStatus: 'Under Review',
          otherDeductionsToDate: 0,
          otherDeductionsPrev: 0,
          signoffs: { consultant: null, siteOffice: null, homeOffice: null },
          returned: null,
          boqItems: [],
          variations: [],
          mos: []
        }
      ]
    },
    p5: {
      id: 'p5',
      name: 'ASCTO Al-Narjis Smart Gated Community - Riyadh',
      sector: 'Residential',
      client: 'ASCTO Residential Development Co.',
      consultant: 'Salfo & Associates Consulting Engineers',
      engineerName: 'Eng. Yousef Al-Amri',
      engineerRole: 'Resident Engineer (Residential)',
      commenceDate: '01 Jan 2025',
      completeDate: '30 Mar 2027',
      activeContractorId: 'c5_res1',
      contractors: [
        {
          id: 'c5_res1',
          companyName: 'Al-Kifah Residential Construction Ltd',
          package: '140 Signature Smart Villas Turnkey Fit-Out',
          sector: 'Residential',
          tradeCategory: 'Residential: Luxury Villa & Apartment Fit-out',
          contractRef: 'ASCTO-RES-RUH-VIL-01',
          repName: 'Eng. Bander Al-Shehri',
          repRole: 'Residential Operations Lead',
          originalContractSum: 112000000,
          advancePaymentOriginal: 11200000,
          advanceRecoveryRate: 0.10,
          retentionRate: 0.10,
          retentionCapRate: 0.05,
          vatRate: 0.15,
          currentIpcNo: 'IPC-04',
          valuationPeriod: '01 Sep 2026 to 25 Sep 2026',
          issueDate: '29 Sep 2026',
          approvalStatus: 'Approved',
          otherDeductionsToDate: 60000,
          otherDeductionsPrev: 60000,
          boqItems: [
            { id: 1, code: 'VIL.01', desc: 'Villa Interior Architectural Joinery & Wardrobes', unit: 'Villas', rate: 280000, contractQty: 140, prevQty: 45, thisQty: 25 },
            { id: 2, code: 'VIL.02', desc: 'Italian Porcelain Large-Format Flooring & Skirting', unit: 'm2', rate: 260, contractQty: 68000, prevQty: 28000, thisQty: 12000 },
            { id: 3, code: 'VIL.03', desc: 'Private Villa Infinity Plunge Pools & Decking', unit: 'Pools', rate: 145000, contractQty: 60, prevQty: 15, thisQty: 12 }
          ],
          variations: [
            { id: 1, code: 'VO-01', desc: 'Upgrade Villa Smart Glass sliding doors to Triple Glaze', date: '15 Apr 2026', approvedSum: 1680000, prevPct: 50, progressPct: 75, status: 'Approved' }
          ],
          mos: [
            { id: 1, code: 'MOS-01', desc: 'Smart Video Intercom & KNX Lighting Automation Hubs', unit: 'Sets', prevQty: 100, qty: 140, invoiceRate: 12500, certPct: 75 }
          ]
        },
        {
          id: 'c5_res2',
          companyName: 'SurePods Middle East Prefabrication',
          package: 'Off-Site Prefabricated Modular Luxury Bathroom Pods',
          sector: 'Residential',
          tradeCategory: 'Residential: Prefabricated Modular Bathroom Pods',
          contractRef: 'ASCTO-RES-RUH-POD-02',
          repName: 'Eng. Nabil Mansour',
          repRole: 'Modular Construction QS',
          originalContractSum: 38500000,
          advancePaymentOriginal: 3850000,
          advanceRecoveryRate: 0.10,
          retentionRate: 0.10,
          retentionCapRate: 0.05,
          vatRate: 0.15,
          currentIpcNo: 'IPC-03',
          valuationPeriod: '01 Sep 2026 to 25 Sep 2026',
          issueDate: '28 Sep 2026',
          approvalStatus: 'Under Review',
          otherDeductionsToDate: 0,
          otherDeductionsPrev: 0,
          boqItems: [
            { id: 1, code: 'POD.01', desc: 'Master Ensuite Steel-Framed Bathroom Pod Units', unit: 'Pods', rate: 58000, contractQty: 320, prevQty: 90, thisQty: 60 },
            { id: 2, code: 'POD.02', desc: 'Guest Powder Room & Secondary Bathroom Pods', unit: 'Pods', rate: 39000, contractQty: 480, prevQty: 140, thisQty: 80 },
            { id: 3, code: 'POD.03', desc: 'On-Site Hook-Up & Hydrostatic Pressure Commissioning', unit: 'Pods', rate: 6500, contractQty: 800, prevQty: 180, thisQty: 110 }
          ],
          variations: [],
          mos: [
            { id: 1, code: 'MOS-01', desc: 'Uninstalled Bathroom Pod Units in Staging Yard', unit: 'Pods', prevQty: 40, qty: 75, invoiceRate: 42000, certPct: 75 }
          ]
        }
      ]
    }
  }
};
