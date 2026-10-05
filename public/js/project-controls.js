// Project controls modules (MTO, TBE/CBE, expediting, logistics, laydown).
// NOTE: these modules still run on in-browser sample data and are not persisted to the server.
        let isAudioMuted = false;

        function toggleAudioMute() {
            isAudioMuted = !isAudioMuted;
            const icon = document.getElementById('audio-icon');
            if (icon) {
                icon.className = isAudioMuted ? 'ph-bold ph-speaker-slash text-rose-400' : 'ph-bold ph-speaker-high text-slate-300';
            }
            showToast(isAudioMuted ? 'UI audio feedback muted.' : 'UI audio feedback active.', 'info');
        }

        function playChime(type = 'success') {
            if (isAudioMuted) return;
            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtx) return;
                const ctx = new AudioCtx();
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);

                const now = ctx.currentTime;
                if (type === 'success') {
                    osc.frequency.setValueAtTime(587.33, now); // D5
                    osc.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5
                } else if (type === 'warning') {
                    osc.frequency.setValueAtTime(440, now);
                    osc.frequency.exponentialRampToValueAtTime(370, now + 0.18);
                } else {
                    osc.frequency.setValueAtTime(520, now);
                    osc.frequency.exponentialRampToValueAtTime(650, now + 0.1);
                }

                gain.gain.setValueAtTime(0.04, now);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
                osc.start(now);
                osc.stop(now + 0.25);
            } catch (e) {
                // Audio policies handled smoothly
            }
        }

        // Service 1: MTO Database
        let mtoItems = [
            { id: 1, tag: "10-PV-8801", discipline: "Piping", desc: "Forged Gate Valve 10\" 600# RF Stellite", spec: "API 600 / ASTM A105", qty: 24, rev: "Rev 02", pkg: "MR-PIP-2026-01", status: "Approved" },
            { id: 2, tag: "P91-PIPE-044", discipline: "Piping", desc: "Seamless Alloy Pipe 16\" Sch 160", spec: "ASTM A335 Gr. P91", qty: 420, rev: "Rev 01", pkg: "MR-PIP-2026-02", status: "In RFQ" },
            { id: 3, tag: "P-101A/B", discipline: "Mechanical", desc: "Crude Booster API 610 Centrifugal Pump", spec: "API 610 11th Ed. BB2", qty: 2, rev: "Rev 03", pkg: "MR-MEC-2026-10", status: "In RFQ" },
            { id: 4, tag: "E-401-SHELL", discipline: "Mechanical", desc: "TEMA AES Heat Exchanger Shell Bundle", spec: "ASME Sec VIII Div 1", qty: 4, rev: "Rev 02", pkg: "MR-MEC-2026-14", status: "Approved" },
            { id: 5, tag: "SWG-33KV-01", discipline: "Electrical", desc: "33kV Gas Insulated Switchgear Panel", spec: "IEC 62271-200", qty: 8, rev: "Rev 01", pkg: "MR-ELE-2026-05", status: "Approved" },
            { id: 6, tag: "HEB-300-STL", discipline: "Structural", desc: "Structural H-Beams Grade S355JR", spec: "EN 10025-2", qty: 150, rev: "Rev 01", pkg: "MR-STR-2026-03", status: "Approved" }
        ];

        // Service 2: Bid Tabulation Database (RFQ Packages)
        const bidPackages = {
            "RFQ-9021": [
                { vendor: "Flowserve Corp.", origin: "USA / Austria", incoterm: "DAP Site", price: 3120000, variance: "-2.5%", leadTime: 36, techScore: 94, composite: 92.4, awarded: true },
                { vendor: "Sulzer Pumps Ltd.", origin: "Switzerland", incoterm: "FCA Antwerp", price: 3280000, variance: "+2.5%", leadTime: 40, techScore: 91, composite: 86.8, awarded: false },
                { vendor: "Ruhrpumpen Global", origin: "Germany", incoterm: "FOB Hamburg", price: 2980000, variance: "-6.8%", leadTime: 44, techScore: 82, composite: 83.2, awarded: false }
            ],
            "RFQ-8840": [
                { vendor: "Vallourec Tubes", origin: "France", incoterm: "CIF Dammam", price: 1850000, variance: "-5.1%", leadTime: 22, techScore: 96, composite: 94.8, awarded: true },
                { vendor: "Tenaris Global", origin: "Italy", incoterm: "CIF Dammam", price: 1920000, variance: "-1.5%", leadTime: 26, techScore: 92, composite: 89.2, awarded: false },
                { vendor: "Nippon Steel Corp.", origin: "Japan", incoterm: "FOB Kobe", price: 2010000, variance: "+3.0%", leadTime: 24, techScore: 95, composite: 88.0, awarded: false }
            ],
            "RFQ-7115": [
                { vendor: "Siemens Energy", origin: "Germany", incoterm: "DDP Site", price: 4200000, variance: "+1.2%", leadTime: 34, techScore: 95, composite: 93.1, awarded: true },
                { vendor: "ABB Power Grids", origin: "Sweden", incoterm: "DAP Site", price: 4150000, variance: "0.0%", leadTime: 38, techScore: 90, composite: 88.5, awarded: false }
            ]
        };

        const rfqBudgets = {
            "RFQ-9021": "$3,200,000",
            "RFQ-8840": "$1,950,000",
            "RFQ-7115": "$4,150,000"
        };

        // Purchase Orders
        let purchaseOrders = [
            { poNumber: "PO-4102", vendor: "Vallourec Tubes", amount: "$1,850,000", incoterm: "CIF Dammam", exWorks: "2026-10-15", milestones: "40% Advance, 50% IRN, 10% Site MRIR", status: "Shop Expediting" },
            { poNumber: "PO-3980", vendor: "Flowserve Corp.", amount: "$3,120,000", incoterm: "DAP Site", exWorks: "2026-09-30", milestones: "20% Drwgs, 60% IRN, 20% PAC", status: "In Transit (Port)" },
            { poNumber: "PO-4050", vendor: "Siemens Energy", amount: "$4,200,000", incoterm: "DDP Site", exWorks: "2026-11-20", milestones: "30% Core, 50% FAT, 20% Site", status: "Quality Witness" }
        ];

        // Service 3: Expediting Milestones & NCRs
        let expeditingData = [
            {
                po: "PO-4102 (P91 Chrome Piping)",
                vendor: "Vallourec - Montbard, France",
                progress: 78,
                critical: true,
                milestones: [
                    { name: "Raw Ingot Sourcing & Heat Analysis", done: true },
                    { name: "Extrusion & Sizing", done: true },
                    { name: "Quench & Temper Heat Treatment", done: true },
                    { name: "Hydrostatic Testing & 100% UT/ET NDT", done: false, delay: "Mill test bench backlog +7 days" },
                    { name: "Final Dimension Inspection & IRN Sign-off", done: false }
                ]
            },
            {
                po: "PO-4050 (33kV Switchgear)",
                vendor: "Siemens - Frankfurt, Germany",
                progress: 88,
                critical: false,
                milestones: [
                    { name: "Cubicle Fabrication & Busbar Plating", done: true },
                    { name: "Circuit Breaker Sub-assembly", done: true },
                    { name: "Factory Acceptance Test (FAT) Witnessed", done: true },
                    { name: "IRN (Inspection Release Note) Issued", done: true },
                    { name: "Seaworthy Export Packing", done: false }
                ]
            }
        ];

        let ncrList = [
            { id: "NCR-2026-04", po: "PO-4102", supplier: "Vallourec", desc: "Surface wall thickness tolerance -0.4mm on 3 sample spool pipes", severity: "Moderate", disposition: "Re-machining & ultrasonic wall thickness re-validation completed.", status: "Resolved" },
            { id: "NCR-2026-05", po: "PO-4050", supplier: "Siemens", desc: "Relay trip timing deviation on Feeder Unit 3 during witness FAT", severity: "Critical", disposition: "Protection relay module swapped and re-calibrated. Awaiting inspector re-witness.", status: "Open" }
        ];

        // Service 4: Logistics Shipments
        let shipments = [
            { id: "MSK-2026-8901", mode: "Ocean", vessel: "MV Maersk Danube", origin: "Antwerp, BEL", dest: "King Abdulaziz Port, Dammam", etd: "2026-09-02", eta: "2026-10-06", progress: 85, customs: "Duty Free (MOF Exempt)", status: "Customs Clearance" },
            { id: "HAP-8840-77", mode: "Ocean", vessel: "Hapag-Lloyd Express", origin: "Marseille, FRA", dest: "Jubail Commercial Port", etd: "2026-09-15", eta: "2026-10-18", progress: 62, customs: "Exemption Pending", status: "In Transit" },
            { id: "SV-AIR-9921", mode: "Air", vessel: "Saudia Cargo B777F", origin: "Frankfurt, DEU", dest: "King Fahd Intl. Airport (DMM)", etd: "2026-09-28", eta: "2026-09-30", progress: 100, customs: "Cleared", status: "Delivered to Laydown" }
        ];

        // Service 5: Laydown Inventory & CWP Readiness
        let laydownInventory = [
            { tag: "10-PV-8801-A", desc: "10\" 600# RF Gate Valve", po: "PO-3980", mrir: "MRIR-2026-140", bin: "Warehouse 1 - Bin R14", qty: 12, cwp: "CWP-01 (Crude Distillation)", status: "Reserved" },
            { tag: "P91-SPOOL-001..020", desc: "Prefabricated P91 Steam Spools", po: "PO-4102", mrir: "MRIR-2026-142", bin: "Zone A - Bay 03", qty: 20, cwp: "CWP-04 (Crude Heater)", status: "Blocked (OS&D)" },
            { tag: "SWG-PNL-01..04", desc: "33kV GIS Switchgear Cabinets", po: "PO-4050", mrir: "MRIR-2026-150", bin: "Warehouse 1 - Bay B", qty: 4, cwp: "CWP-08 (Substation 4)", status: "Available" },
            { tag: "ST-BEAM-S355-100", desc: "Heavy Pipe Rack Columns 12m", po: "PO-3810", mrir: "MRIR-2026-118", bin: "Zone B - Open Laydown", qty: 48, cwp: "CWP-02 (Offsite Pipe Rack)", status: "Issued to Site" }
        ];

        let osdRecords = [
            { id: "OSD-2026-01", type: "Damaged", po: "PO-4102", shipment: "MSK-2026-8901", item: "P91 Pipe Spool (Spool #14)", qty: 2, claim: "Carrier Lloyd's Claim #892", resolution: "Mill rushing priority replacement via Air Freight", status: "Open" },
            { id: "OSD-2026-02", type: "Shortage", po: "PO-3980", shipment: "HAP-8840-77", item: "B7 Stud Bolts & Teflon Gaskets M24", qty: 80, claim: "Vendor Dispatched", resolution: "Vendor conceded packing list mistake. Dispatched courier.", status: "In Progress" },
            { id: "OSD-2026-03", type: "Damaged", po: "PO-3810", shipment: "SV-AIR-9921", item: "Honeywell Pressure Transmitter", qty: 1, claim: "Insurance Settled", resolution: "Site local emergency vendor PO issued.", status: "Closed" }
        ];

        let cwpList = [
            { cwp: "CWP-01", name: "Crude Distillation Piping Installation", totalItems: 120, onSite: 114, readiness: 95, status: "Ready to Erect", criticalShortages: "None (Minor non-critical bolt sets)" },
            { cwp: "CWP-04", name: "Fired Heater Radiant Tubes & High-Pressure Piping", totalItems: 85, onSite: 54, readiness: 63, status: "Constrained", criticalShortages: "2x P91 Spools in OS&D Hold" },
            { cwp: "CWP-08", name: "Main Substation Electrical Energization", totalItems: 40, onSite: 38, readiness: 95, status: "Ready to Erect", criticalShortages: "None" }
        ];

        function initApp() {
            renderDashboardChart();
            renderMTOTable();
            renderBidMatrix();
            renderPOsTable();
            renderExpediting();
            renderNCRTable();
            renderLogisticsTable();
            renderLaydownTable();
            renderCWPReadiness();
            renderOSDTable();
            setupModalBackdrops();
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initApp);
        } else {
            initApp();
        }

        function switchTab(tabId) {
            const sections = ['rfq', 'vendors', 'dashboard', 'service1', 'service2', 'service3', 'service4', 'service5'];
            sections.forEach(s => {
                const el = document.getElementById(`tab-${s}`);
                const btn = document.getElementById(`nav-${s}`);
                if (el) el.classList.add('hidden');
                if (btn) btn.classList.remove('active');
            });

            const targetSec = document.getElementById(`tab-${tabId}`);
            const targetBtn = document.getElementById(`nav-${tabId}`);
            if (targetSec) targetSec.classList.remove('hidden');
            if (targetBtn) targetBtn.classList.add('active');

            if (tabId === 'dashboard' && pipelineChartInstance) {
                setTimeout(() => {
                    pipelineChartInstance.resize();
                }, 50);
            }
            document.dispatchEvent(new CustomEvent('astco:tab', { detail: tabId }));
        }

        let pipelineChartInstance = null;
        function renderDashboardChart() {
            const chartCanvas = document.getElementById('pipelineChart');
            if (!chartCanvas || typeof Chart === 'undefined') return;
            const ctx = chartCanvas.getContext('2d');
            if (pipelineChartInstance) pipelineChartInstance.destroy();

            pipelineChartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: [
                        '1. Eng MTO Ingestion',
                        '2. In Sourcing / RFQ',
                        '3. Shop Fabrication',
                        '4. IRN Released',
                        '5. International Transit',
                        '6. Port Customs Clearance',
                        '7. Site Laydown / Issued'
                    ],
                    datasets: [{
                        label: 'Material Tags in Stage',
                        data: [3420, 2890, 2150, 1680, 1240, 890, 680],
                        backgroundColor: [
                            'rgba(37, 99, 235, 0.75)',
                            'rgba(79, 70, 229, 0.75)',
                            'rgba(147, 51, 234, 0.75)',
                            'rgba(219, 39, 119, 0.75)',
                            'rgba(217, 119, 6, 0.75)',
                            'rgba(14, 165, 233, 0.75)',
                            'rgba(16, 185, 129, 0.75)'
                        ],
                        borderColor: [
                            '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#f59e0b', '#0ea5e9', '#10b981'
                        ],
                        borderWidth: 1.5,
                        borderRadius: 6
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: '#0a0f1d',
                            titleColor: '#fff',
                            bodyColor: '#cbd5e1',
                            borderColor: '#1e293b',
                            borderWidth: 1,
                            padding: 12
                        }
                    },
                    scales: {
                        y: {
                            grid: { color: 'rgba(255, 255, 255, 0.05)' },
                            ticks: { color: '#94a3b8', font: { family: 'JetBrains Mono', size: 10 } }
                        },
                        x: {
                            grid: { display: false },
                            ticks: { color: '#94a3b8', font: { size: 10 } }
                        }
                    }
                }
            });
        }

        function renderMTOTable(filteredData = mtoItems) {
            const tbody = document.getElementById('mto-table-body');
            if (!tbody) return;
            tbody.innerHTML = '';
            const esc = ASTCO.esc;

            filteredData.forEach(item => {
                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-800/40 transition";
                tr.innerHTML = `
                    <td class="p-3.5 font-bold text-white">${esc(item.tag)}</td>
                    <td class="p-3.5"><span class="px-2 py-0.5 rounded text-[10px] bg-slate-800 text-blue-300 border border-slate-700 font-sans font-medium">${esc(item.discipline)}</span></td>
                    <td class="p-3.5 font-sans text-slate-200 text-xs">${esc(item.desc)}</td>
                    <td class="p-3.5 text-slate-400 text-xs">${esc(item.spec)}</td>
                    <td class="p-3.5 text-right font-bold text-white">${esc(item.qty)}</td>
                    <td class="p-3.5 text-slate-400"><span class="bg-slate-800/80 px-2 py-0.5 rounded text-[10px]">${esc(item.rev)}</span></td>
                    <td class="p-3.5 text-blue-400 font-semibold">${esc(item.pkg)}</td>
                    <td class="p-3.5">
                        <span class="px-2.5 py-0.5 rounded-full text-[10px] font-sans font-semibold ${
                            item.status === 'Approved' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' :
                            item.status === 'In RFQ' ? 'bg-blue-950 text-blue-400 border border-blue-800' :
                            'bg-amber-950 text-amber-400 border border-amber-800'
                        }">${esc(item.status)}</span>
                    </td>
                    <td class="p-3.5 text-center">
                        <button data-mto-id="${item.id}" title="Raise a live RFQ to matched vendors" class="text-blue-400 hover:text-blue-300 px-2.5 py-1 bg-blue-950/60 rounded-md border border-blue-800 hover:border-blue-600 transition flex items-center gap-1 mx-auto">
                            <i class="ph-bold ph-package"></i> RFQ
                        </button>
                    </td>
                `;
                tr.querySelector('[data-mto-id]').addEventListener('click', () => bundleToRFQ(item));
                tbody.appendChild(tr);
            });
        }

        function filterMTO() {
            const query = (document.getElementById('mto-search')?.value || '').toLowerCase();
            const discipline = document.getElementById('mto-discipline')?.value || 'ALL';
            const status = document.getElementById('mto-status')?.value || 'ALL';

            const filtered = mtoItems.filter(item => {
                const matchesQuery = item.tag.toLowerCase().includes(query) ||
                                     item.desc.toLowerCase().includes(query) ||
                                     item.spec.toLowerCase().includes(query);
                const matchesDisc = discipline === 'ALL' || item.discipline === discipline;
                const matchesStatus = status === 'ALL' || item.status === status;
                return matchesQuery && matchesDisc && matchesStatus;
            });
            renderMTOTable(filtered);
        }

        // Hands the MTO line to the live RFQ form (see procurement.js).
        function bundleToRFQ(item) {
            playChime('success');
            if (window.prefillRfqFromMto) window.prefillRfqFromMto(item);
        }

        function simulateBIMSync() {
            playChime('info');
            showToast('Synchronizing with Hexagon Smart3D / AVEVA E3D engineering database...', 'info');
            setTimeout(() => {
                playChime('success');
                showToast('Model sync complete. 14 new piping tags and 2 revised spools integrated!', 'success');
            }, 1200);
        }

        function renderBidMatrix() {
            const rfqSelector = document.getElementById('rfq-selector');
            if (!rfqSelector) return;
            const rfqKey = rfqSelector.value;
            const bids = bidPackages[rfqKey] || [];
            const tbody = document.getElementById('bid-matrix-body');
            if (!tbody) return;
            tbody.innerHTML = '';

            const budgetEl = document.getElementById('rfq-budget-display');
            if (budgetEl && rfqBudgets[rfqKey]) {
                budgetEl.textContent = rfqBudgets[rfqKey];
            }

            // Determine best score recommendation
            let bestBid = bids[0];
            bids.forEach(b => {
                if (b.composite > (bestBid?.composite || 0)) bestBid = b;
            });

            const badge = document.getElementById('award-recommendation-badge');
            if (badge && bestBid) {
                badge.textContent = `Recommended: ${bestBid.vendor} (${bestBid.composite} Composite)`;
            }

            bids.forEach((bid, index) => {
                const tr = document.createElement('tr');
                tr.className = `hover:bg-slate-800/40 transition ${bid.awarded ? 'bg-blue-950/25 border-l-2 border-l-blue-500' : ''}`;
                tr.innerHTML = `
                    <td class="p-3 font-bold ${bid.awarded ? 'text-blue-400' : 'text-white'} flex items-center gap-2">
                        ${bid.awarded ? '<i class="ph-bold ph-trophy text-amber-400"></i>' : ''}
                        ${bid.vendor}
                    </td>
                    <td class="p-3 font-sans text-slate-400">${bid.origin}</td>
                    <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 font-sans">${bid.incoterm}</span></td>
                    <td class="p-3 text-right font-bold text-white">$${bid.price.toLocaleString()}</td>
                    <td class="p-3 text-right ${bid.variance.startsWith('-') ? 'text-emerald-400' : 'text-rose-400'} font-semibold">${bid.variance}</td>
                    <td class="p-3 text-center text-slate-300">${bid.leadTime} wks</td>
                    <td class="p-3 text-center font-bold ${bid.techScore >= 90 ? 'text-emerald-400' : 'text-amber-400'}">${bid.techScore}</td>
                    <td class="p-3 text-center">
                        <span class="px-2 py-0.5 rounded font-bold ${bid.composite >= 90 ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-slate-800 text-slate-300'}">
                            ${bid.composite}
                        </span>
                    </td>
                    <td class="p-3 text-center">
                        ${bid.awarded
                            ? '<span class="px-2.5 py-1 rounded-full text-[10px] font-sans font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800">PO Awarded</span>'
                            : `<button onclick="awardPOByIndex(${index})" class="px-2.5 py-1 bg-slate-800 hover:bg-blue-600 text-slate-300 hover:text-white rounded-md text-[10px] font-sans font-medium transition active:scale-95">Award PO</button>`
                        }
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }

        function awardPOByIndex(index) {
            const rfqKey = document.getElementById('rfq-selector').value;
            const bids = bidPackages[rfqKey] || [];
            if (!bids[index]) return;

            bids.forEach((b, i) => b.awarded = (i === index));
            const selected = bids[index];

            const newPoNum = `PO-${Math.floor(4200 + Math.random() * 800)}`;
            purchaseOrders.unshift({
                poNumber: newPoNum,
                vendor: selected.vendor,
                amount: `$${selected.price.toLocaleString()}`,
                incoterm: selected.incoterm,
                exWorks: "2026-12-15",
                milestones: "30% Advance, 50% FAT, 20% Delivery",
                status: "PO Executed"
            });

            renderBidMatrix();
            renderPOsTable();
            playChime('success');
            showToast(`Formal Purchase Order ${newPoNum} awarded to ${selected.vendor}!`, 'success');
        }

        function renderPOsTable() {
            const tbody = document.getElementById('pos-table-body');
            if (!tbody) return;
            tbody.innerHTML = '';

            purchaseOrders.forEach(po => {
                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-800/40 transition";
                tr.innerHTML = `
                    <td class="p-3 font-bold text-blue-400">${po.poNumber}</td>
                    <td class="p-3 font-sans text-white font-medium">${po.vendor}</td>
                    <td class="p-3 font-bold text-white">${po.amount}</td>
                    <td class="p-3 font-sans text-slate-400 text-xs">${po.incoterm}</td>
                    <td class="p-3 text-slate-300">${po.exWorks}</td>
                    <td class="p-3 font-sans text-[11px] text-slate-400">${po.milestones}</td>
                    <td class="p-3">
                        <span class="px-2.5 py-0.5 rounded-full text-[10px] font-sans font-semibold bg-blue-950 text-blue-300 border border-blue-800">${po.status}</span>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }

        function renderExpediting() {
            const container = document.getElementById('expediting-cards-container');
            if (!container) return;
            container.innerHTML = '';

            expeditingData.forEach(item => {
                const card = document.createElement('div');
                card.className = "p-4 bg-industrial-900 rounded-xl border border-slate-800 space-y-3";

                let milestonesHTML = '';
                item.milestones.forEach(m => {
                    milestonesHTML += `
                        <div class="flex items-center justify-between text-xs py-1.5 border-b border-slate-800/50 last:border-none">
                            <span class="flex items-center gap-2 ${m.done ? 'text-slate-200' : 'text-slate-400'} font-sans">
                                <i class="ph-bold ${m.done ? 'ph-check-circle text-emerald-400' : 'ph-circle text-slate-600'} text-base"></i>
                                ${m.name}
                            </span>
                            ${m.delay ? `<span class="text-[10px] text-rose-400 bg-rose-950/80 px-2 py-0.5 rounded border border-rose-800 font-mono">${m.delay}</span>` : ''}
                            ${m.done ? `<span class="text-[10px] text-emerald-400 font-mono font-semibold">Completed</span>` : ''}
                        </div>
                    `;
                });

                card.innerHTML = `
                    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div>
                            <div class="font-bold text-white text-sm flex items-center gap-2">
                                ${item.po}
                                ${item.critical ? '<span class="px-2 py-0.5 rounded text-[10px] bg-rose-950 text-rose-400 border border-rose-800 uppercase font-mono">Critical Path</span>' : ''}
                            </div>
                            <span class="text-xs text-slate-400 font-sans">${item.vendor}</span>
                        </div>
                        <div class="flex items-center gap-3">
                            <div class="text-right">
                                <div class="text-xs font-mono font-bold text-white">${item.progress}% Complete</div>
                            </div>
                            <button onclick="issueIRN('${item.po}')" class="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-sans font-semibold transition flex items-center gap-1.5 shadow-md shadow-emerald-600/30">
                                <i class="ph-bold ph-certificate"></i> Issue IRN
                            </button>
                        </div>
                    </div>
                    <!-- Progress Bar -->
                    <div class="w-full bg-industrial-950 rounded-full h-2.5 overflow-hidden border border-slate-800">
                        <div class="bg-gradient-to-r from-blue-500 to-emerald-500 h-2.5 rounded-full transition-all duration-500" style="width: ${item.progress}%;"></div>
                    </div>
                    <!-- Milestones -->
                    <div class="bg-industrial-950/70 rounded-xl p-3 border border-slate-800 space-y-1">
                        ${milestonesHTML}
                    </div>
                `;
                container.appendChild(card);
            });
        }

        function issueIRN(po) {
            playChime('success');
            showToast(`Inspection Release Note (IRN) officially stamped for ${po}! Goods authorized for ocean dispatch.`, 'success');
        }

        function renderNCRTable() {
            const tbody = document.getElementById('ncr-table-body');
            if (!tbody) return;
            tbody.innerHTML = '';
            const esc = ASTCO.esc;

            ncrList.forEach(ncr => {
                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-800/40 transition";
                tr.innerHTML = `
                    <td class="p-3 font-bold text-rose-400">${esc(ncr.id)}</td>
                    <td class="p-3 text-blue-400 font-semibold">${esc(ncr.po)}</td>
                    <td class="p-3 font-sans text-slate-300">${esc(ncr.supplier)}</td>
                    <td class="p-3 font-sans text-slate-200 text-xs">${esc(ncr.desc)}</td>
                    <td class="p-3">
                        <span class="px-2 py-0.5 rounded text-[10px] font-sans ${ncr.severity === 'Critical' ? 'bg-rose-950 text-rose-400 border border-rose-800' : 'bg-amber-950 text-amber-400 border border-amber-800'}">${esc(ncr.severity)}</span>
                    </td>
                    <td class="p-3 font-sans text-[11px] text-slate-400">${esc(ncr.disposition)}</td>
                    <td class="p-3">
                        <span class="px-2.5 py-0.5 rounded-full text-[10px] font-sans font-semibold ${ncr.status === 'Resolved' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'}">${esc(ncr.status)}</span>
                    </td>
                    <td class="p-3 text-center">
                        ${ncr.status === 'Open' ? `
                            <button onclick="resolveNCR('${esc(ncr.id)}')" class="px-2.5 py-1 bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-800 rounded-md text-[10px] font-sans font-medium transition active:scale-95">Close NCR</button>
                        ` : `<span class="text-slate-500 text-[10px] font-mono">Closed</span>`}
                    </td>
                `;
                tbody.appendChild(tr);
            });
            const openNcrEl = document.getElementById('open-ncr-count');
            if (openNcrEl) {
                const openCount = ncrList.filter(n => n.status === 'Open').length;
                openNcrEl.textContent = `${openCount} Actionable Item${openCount === 1 ? '' : 's'}`;
            }
        }

        function resolveNCR(id) {
            const item = ncrList.find(n => n.id === id);
            if (item) {
                item.status = "Resolved";
                renderNCRTable();
                playChime('success');
                showToast(`Non-Conformance ${id} marked as resolved following QA re-audit.`, 'success');
            }
        }

        function renderLogisticsTable() {
            const tbody = document.getElementById('logistics-table-body');
            if (!tbody) return;
            tbody.innerHTML = '';

            shipments.forEach(s => {
                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-800/40 transition";
                tr.innerHTML = `
                    <td class="p-3 font-bold text-white flex items-center gap-1.5">
                        <i class="ph-bold ${s.mode === 'Ocean' ? 'ph-boat text-blue-400' : s.mode === 'Air' ? 'ph-airplane text-sky-400' : 'ph-truck text-amber-400'}"></i>
                        ${s.id}
                    </td>
                    <td class="p-3 font-sans text-slate-300">${s.vessel}</td>
                    <td class="p-3 font-sans text-slate-400">${s.origin}</td>
                    <td class="p-3 font-sans text-slate-300 font-medium">${s.dest}</td>
                    <td class="p-3 text-slate-400 text-[11px]">${s.etd} / <strong class="text-white">${s.eta}</strong></td>
                    <td class="p-3">
                        <div class="flex items-center gap-2">
                            <div class="w-full bg-industrial-950 rounded-full h-2 overflow-hidden border border-slate-800">
                                <div class="bg-blue-500 h-2 rounded-full transition-all duration-500" style="width: ${s.progress}%;"></div>
                            </div>
                            <span class="text-[10px] font-mono text-slate-300 font-semibold">${s.progress}%</span>
                        </div>
                    </td>
                    <td class="p-3 font-sans text-[11px] text-emerald-400">${s.customs}</td>
                    <td class="p-3">
                        <span class="px-2.5 py-0.5 rounded-full text-[10px] font-sans font-semibold ${s.status === 'Cleared' || s.status === 'Delivered to Laydown' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-blue-950 text-blue-300 border border-blue-800'}">${s.status}</span>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }

        function renderLaydownTable(zone = 'ALL') {
            const tbody = document.getElementById('laydown-table-body');
            if (!tbody) return;
            tbody.innerHTML = '';

            const data = zone === 'ALL' ? laydownInventory : laydownInventory.filter(item => item.bin.includes(zone));

            data.forEach(item => {
                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-800/40 transition";
                tr.innerHTML = `
                    <td class="p-3 font-bold text-white">${item.tag}</td>
                    <td class="p-3 font-sans text-slate-200 text-xs">${item.desc}</td>
                    <td class="p-3 text-blue-400">${item.po}</td>
                    <td class="p-3 text-slate-400">${item.mrir}</td>
                    <td class="p-3 font-sans text-amber-300"><i class="ph-bold ph-map-pin mr-1 text-xs"></i>${item.bin}</td>
                    <td class="p-3 text-right font-bold text-white">${item.qty}</td>
                    <td class="p-3 font-sans text-slate-300 text-xs font-medium">${item.cwp}</td>
                    <td class="p-3 text-center">
                        <span class="px-2.5 py-0.5 rounded-full text-[10px] font-sans font-semibold ${
                            item.status === 'Available' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' :
                            item.status === 'Reserved' ? 'bg-blue-950 text-blue-400 border border-blue-800' :
                            item.status === 'Issued to Site' ? 'bg-indigo-950 text-indigo-300 border border-indigo-800' :
                            'bg-rose-950 text-rose-400 border border-rose-800'
                        }">${item.status}</span>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }

        function filterLaydown(zone) {
            ['all', 'zonea', 'zoneb', 'wh1'].forEach(id => {
                const b = document.getElementById(`laydown-btn-${id}`);
                if (b) {
                    b.className = "px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-200 transition font-medium";
                }
            });
            const activeKey = zone === 'ALL' ? 'all' : zone.includes('Zone A') ? 'zonea' : zone.includes('Zone B') ? 'zoneb' : 'wh1';
            const activeBtn = document.getElementById(`laydown-btn-${activeKey}`);
            if (activeBtn) {
                activeBtn.className = "px-3 py-1 bg-blue-600 text-white rounded-lg transition font-medium";
            }
            renderLaydownTable(zone);
        }

        function renderCWPReadiness() {
            const container = document.getElementById('cwp-readiness-grid');
            if (!container) return;
            container.innerHTML = '';

            cwpList.forEach(pkg => {
                const card = document.createElement('div');
                card.className = "p-4 bg-industrial-900 rounded-xl border border-slate-800 space-y-3";
                card.innerHTML = `
                    <div class="flex items-center justify-between">
                        <span class="font-bold text-white text-sm font-mono text-blue-400">${pkg.cwp}</span>
                        <span class="px-2.5 py-0.5 rounded text-[10px] font-semibold font-sans ${pkg.status === 'Ready to Erect' ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-rose-950 text-rose-300 border border-rose-800'}">
                            ${pkg.status}
                        </span>
                    </div>
                    <div class="text-xs font-semibold text-slate-200">${pkg.name}</div>

                    <div>
                        <div class="flex items-center justify-between text-xs text-slate-400 mb-1">
                            <span>Material Availability</span>
                            <span class="font-mono font-bold text-white">${pkg.readiness}% (${pkg.onSite}/${pkg.totalItems} tags)</span>
                        </div>
                        <div class="w-full bg-industrial-950 rounded-full h-2.5 overflow-hidden border border-slate-800">
                            <div class="h-2.5 rounded-full ${pkg.readiness >= 90 ? 'bg-emerald-500' : 'bg-rose-500'}" style="width: ${pkg.readiness}%;"></div>
                        </div>
                    </div>

                    <div class="text-[11px] text-slate-400 bg-industrial-950/80 p-2.5 rounded-lg border border-slate-800">
                        <span class="font-semibold text-slate-300">Bottlenecks:</span> ${pkg.criticalShortages}
                    </div>

                    <button onclick="issuePackageToWork('${pkg.cwp}')" class="w-full py-2 ${pkg.status === 'Ready to Erect' ? 'bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-600/30' : 'bg-slate-800/80 text-slate-400 cursor-not-allowed'} text-white rounded-lg text-xs font-semibold transition active:scale-95">
                        Release Field Work Package (FIWP)
                    </button>
                `;
                container.appendChild(card);
            });
        }

        function issuePackageToWork(cwp) {
            const pkg = cwpList.find(c => c.cwp === cwp);
            if (pkg && pkg.status === 'Ready to Erect') {
                playChime('success');
                showToast(`Work package ${cwp} released to construction site installation crew!`, 'success');
            } else {
                playChime('warning');
                showToast(`Cannot release ${cwp} due to missing critical-path materials! Resolve OS&D items first.`, 'error');
            }
        }

        function renderOSDTable() {
            const tbody = document.getElementById('osd-table-body');
            if (!tbody) return;
            tbody.innerHTML = '';
            const esc = ASTCO.esc;

            osdRecords.forEach(osd => {
                const tr = document.createElement('tr');
                tr.className = "hover:bg-slate-800/40 transition";
                tr.innerHTML = `
                    <td class="p-3 font-bold text-rose-400">${esc(osd.id)}</td>
                    <td class="p-3">
                        <span class="px-2 py-0.5 rounded text-[10px] font-sans ${osd.type === 'Damaged' ? 'bg-rose-950 text-rose-300 border border-rose-800' : 'bg-amber-950 text-amber-300 border border-amber-800'}">${esc(osd.type)}</span>
                    </td>
                    <td class="p-3 font-sans text-xs text-blue-400">${esc(osd.po)} • ${esc(osd.shipment)}</td>
                    <td class="p-3 font-sans text-white text-xs">${esc(osd.item)}</td>
                    <td class="p-3 text-center font-bold text-rose-400">${esc(osd.qty)}</td>
                    <td class="p-3 font-sans text-[11px] text-slate-400">${esc(osd.claim)}</td>
                    <td class="p-3 font-sans text-[11px] text-slate-300">${esc(osd.resolution)}</td>
                    <td class="p-3 text-center">
                        <span class="px-2.5 py-0.5 rounded-full text-[10px] font-sans font-semibold ${osd.status === 'Closed' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'}">${esc(osd.status)}</span>
                    </td>
                `;
                tbody.appendChild(tr);
            });
            const counter = document.getElementById('osd-counter');
            if (counter) {
                counter.textContent = `${osdRecords.filter(o => o.status !== 'Closed').length} Open Discrepancies`;
            }
        }

        function openModal(id) {
            ASTCO.openModal(id);
        }

        function closeModal(id) {
            ASTCO.closeModal(id);
        }

        const ALL_MODALS = ['new-mto-modal', 'new-osd-modal', 'new-ncr-modal', 'new-mrir-modal', 'rfq-detail-modal', 'vendor-catalog-modal', 'category-modal'];

        function setupModalBackdrops() {
            ALL_MODALS.forEach(modalId => {
                const modal = document.getElementById(modalId);
                if (modal) {
                    modal.addEventListener('click', (e) => {
                        if (e.target === modal) closeModal(modalId);
                    });
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    ALL_MODALS.forEach(closeModal);
                }
            });
        }

        function handleCreateMTO(e) {
            e.preventDefault();
            const tag = document.getElementById('modal-mto-tag').value;
            const discipline = document.getElementById('modal-mto-discipline').value;
            const spec = document.getElementById('modal-mto-spec').value;
            const desc = document.getElementById('modal-mto-desc').value;
            const qty = parseInt(document.getElementById('modal-mto-qty').value, 10);
            const pkg = document.getElementById('modal-mto-pkg').value;

            mtoItems.unshift({
                id: Date.now(),
                tag,
                discipline,
                desc,
                spec,
                qty,
                rev: "Rev 01",
                pkg,
                status: "Approved"
            });

            renderMTOTable();
            closeModal('new-mto-modal');
            playChime('success');
            showToast(`MTO item ${tag} successfully added to engineering database!`, 'success');
            e.target.reset();
        }

        function handleCreateOSD(e) {
            e.preventDefault();
            const type = document.getElementById('modal-osd-type').value;
            const po = document.getElementById('modal-osd-po').value;
            const desc = document.getElementById('modal-osd-desc').value;
            const qty = parseInt(document.getElementById('modal-osd-qty').value, 10);
            const claim = document.getElementById('modal-osd-claim').value;
            const resolution = document.getElementById('modal-osd-resolution').value;

            const newId = `OSD-2026-0${osdRecords.length + 1}`;
            osdRecords.unshift({
                id: newId,
                type,
                po,
                shipment: "CONSIGNMENT-INSP",
                item: desc,
                qty,
                claim,
                resolution,
                status: "Open"
            });

            renderOSDTable();
            closeModal('new-osd-modal');
            playChime('warning');
            showToast(`OS&D Report ${newId} logged with shipping claims adjuster!`, 'warning');
            e.target.reset();
        }

        function handleCreateNCR(e) {
            e.preventDefault();
            const po = document.getElementById('modal-ncr-po').value;
            const severity = document.getElementById('modal-ncr-severity').value;
            const supplier = document.getElementById('modal-ncr-supplier').value;
            const desc = document.getElementById('modal-ncr-desc').value;
            const disposition = document.getElementById('modal-ncr-disposition').value;

            const newNcrId = `NCR-2026-0${ncrList.length + 4}`;
            ncrList.unshift({
                id: newNcrId,
                po,
                supplier,
                desc,
                severity,
                disposition,
                status: "Open"
            });

            renderNCRTable();
            closeModal('new-ncr-modal');
            playChime('warning');
            showToast(`Non-Conformance ${newNcrId} raised against ${supplier}!`, 'warning');
            e.target.reset();
        }

        function handleCreateMRIR(e) {
            e.preventDefault();
            const waybill = document.getElementById('modal-mrir-waybill').value;
            const zone = document.getElementById('modal-mrir-zone').value;

            const newMrirNum = `MRIR-2026-${Math.floor(160 + Math.random() * 40)}`;
            laydownInventory.unshift({
                tag: `INCOMING-${Math.floor(100 + Math.random() * 900)}`,
                desc: `Material Lot from ${waybill}`,
                po: "PO-VERIFIED",
                mrir: newMrirNum,
                bin: zone,
                qty: 15,
                cwp: "CWP-01 (Crude Distillation)",
                status: "Available"
            });

            renderLaydownTable();
            closeModal('new-mrir-modal');
            playChime('success');
            showToast(`Material Receiving Report ${newMrirNum} stamped & inventory slotted to ${zone}!`, 'success');
        }

        function switchProjectAsset(assetKey) {
            playChime('info');
            if (assetKey === 'p1') {
                document.getElementById('dash-committed-spend').textContent = '$42,850,000';
                document.getElementById('dash-mto-count').textContent = '148 Packages';
                document.getElementById('dash-cwp-index').textContent = '88.4%';
            } else if (assetKey === 'p2') {
                document.getElementById('dash-committed-spend').textContent = '$68,400,000';
                document.getElementById('dash-mto-count').textContent = '212 Packages';
                document.getElementById('dash-cwp-index').textContent = '94.1%';
            } else {
                document.getElementById('dash-committed-spend').textContent = '$31,100,000';
                document.getElementById('dash-mto-count').textContent = '95 Packages';
                document.getElementById('dash-cwp-index').textContent = '76.8%';
            }
            showToast('Capital asset project profile re-indexed successfully.', 'info');
        }

        function exportTBEReport() {
            playChime('success');
            showToast('Generating official EPC Technical & Commercial Bid Tabulation Dossier (PDF/XLS)...', 'success');
        }

        function downloadPOListJSON() {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(purchaseOrders, null, 2));
            const downloadAnchor = document.createElement('a');
            downloadAnchor.setAttribute("href", dataStr);
            downloadAnchor.setAttribute("download", "ASTCO_POs_Committed.json");
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            downloadAnchor.remove();
            showToast('Committed PO ledger exported to JSON.', 'success');
        }

        // Toasts are rendered through ASTCO.toast, which HTML-escapes the message.
        function showToast(message, type = 'info') {
            ASTCO.toast(message, type);
        }
