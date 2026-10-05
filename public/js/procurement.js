// Live, server-backed procurement features: RFQ dispatch, quote evaluation, vendor network.
(function () {
  const { esc, api, toast, money, fmtDate, statusPill, categoryBadges, categoryPicker, checkedIds, kindLabel, groupByKind, localInputValue } = ASTCO;
  const ROLE_LABELS = { admin: 'Administrator', procurement_manager: 'Procurement Manager', procurement_staff: 'Procurement Staff', vendor: 'Vendor' };

  let me = null;
  let categories = [];
  let rfqs = [];
  let vendors = [];
  let matched = [];
  const excluded = new Set();
  const isManager = () => me && (me.role === 'admin' || me.role === 'procurement_manager');

  // ---------------- RFQ dispatch ----------------
  function renderRfqCategories(filter = '') {
    const root = document.getElementById('rfq-categories');
    const selected = new Set(checkedIds(root, 'rfqcat'));
    const f = filter.trim().toLowerCase();
    const visible = f ? categories.filter((c) => c.name.toLowerCase().includes(f) || selected.has(c.id)) : categories;
    root.innerHTML = categoryPicker(visible, 'rfqcat', selected);
    // Keep hidden-but-selected categories selected when filtering.
    for (const id of selected) {
      if (!visible.some((c) => c.id === id)) root.insertAdjacentHTML('beforeend', `<input type="checkbox" name="rfqcat" value="${id}" checked hidden>`);
    }
  }

  let matchTimer = null;
  function scheduleMatch() {
    clearTimeout(matchTimer);
    matchTimer = setTimeout(refreshMatches, 200);
  }

  async function refreshMatches() {
    const ids = checkedIds(document.getElementById('rfq-categories'), 'rfqcat');
    const list = document.getElementById('match-list');
    if (!ids.length) {
      matched = [];
      list.innerHTML = '<div class="text-slate-500 text-center py-6">Select one or more categories to see which registered vendors will receive this RFQ.</div>';
      updateDispatchButton();
      return;
    }
    try {
      matched = (await api('POST', '/api/rfqs/match', { category_ids: ids })).vendors;
    } catch (err) { toast(err.message, 'error'); return; }
    if (!matched.length) {
      list.innerHTML = `<div class="text-amber-300 bg-amber-950/40 border border-amber-800/60 rounded-lg p-3">No active registered vendor supplies this combination.
        Try fewer categories, or invite a vendor from the <button type="button" class="underline" onclick="switchTab('vendors')">Vendor Network</button> tab.</div>`;
    } else {
      list.innerHTML = matched.map((v) => `
        <label class="flex items-center gap-2.5 p-2.5 rounded-lg bg-industrial-950 border border-slate-800 hover:border-blue-700 cursor-pointer">
          <input type="checkbox" data-vendor="${v.id}" ${excluded.has(v.id) ? '' : 'checked'}>
          <span class="flex-1 text-slate-200 font-medium">${esc(v.company_name)}</span>
          <span class="text-[10px] text-slate-500">${esc(v.country || '')}</span>
        </label>`).join('');
      list.querySelectorAll('[data-vendor]').forEach((cb) => cb.addEventListener('change', () => {
        const id = Number(cb.dataset.vendor);
        if (cb.checked) excluded.delete(id); else excluded.add(id);
        updateDispatchButton();
      }));
    }
    updateDispatchButton();
  }

  function recipientCount() {
    return matched.filter((v) => !excluded.has(v.id)).length;
  }

  function updateDispatchButton() {
    const n = recipientCount();
    document.getElementById('match-count').textContent = `${n} of ${matched.length}`;
    document.getElementById('dispatch-btn').disabled = n === 0;
    document.getElementById('dispatch-label').textContent = n ? `Dispatch RFQ to ${n} vendor${n === 1 ? '' : 's'}` : 'Dispatch RFQ';
  }

  function resetRfqForm() {
    document.getElementById('rfq-form').reset();
    const closes = new Date(Date.now() + 3 * 24 * 3600e3);
    closes.setHours(17, 0, 0, 0);
    document.getElementById('rfq-closes').value = localInputValue(closes);
    excluded.clear();
    renderRfqCategories();
    refreshMatches();
  }

  document.getElementById('rfq-categories').addEventListener('change', scheduleMatch);
  document.getElementById('cat-filter').addEventListener('input', (e) => renderRfqCategories(e.target.value));

  document.getElementById('rfq-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('dispatch-btn');
    btn.disabled = true;
    try {
      const requiredBy = document.getElementById('rfq-required-by').value;
      const res = await api('POST', '/api/rfqs', {
        title: document.getElementById('rfq-title').value,
        description: document.getElementById('rfq-desc').value,
        quantity: Number(document.getElementById('rfq-qty').value),
        unit: document.getElementById('rfq-unit').value,
        required_by: requiredBy ? new Date(requiredBy + 'T00:00:00').toISOString() : undefined,
        delivery_location: document.getElementById('rfq-location').value,
        closes_at: new Date(document.getElementById('rfq-closes').value).toISOString(),
        sealed: document.getElementById('rfq-sealed').checked,
        category_ids: checkedIds(document.getElementById('rfq-categories'), 'rfqcat'),
        exclude_vendor_ids: [...excluded],
      });
      if (typeof playChime === 'function') playChime('success');
      toast(`${res.rfq.ref} dispatched to ${res.recipients.length} vendor(s).`, 'success');
      resetRfqForm();
      await loadRfqs();
    } catch (err) {
      toast(err.message, 'error');
      updateDispatchButton();
    }
  });

  // Called from the MTO table "RFQ" button.
  const MTO_DISCIPLINE_TO_CATEGORY = { Piping: 'Piping', Mechanical: 'Mechanical', Electrical: 'Electrical', Structural: 'Civil & Structural' };
  window.prefillRfqFromMto = function (item) {
    switchTab('rfq');
    document.getElementById('rfq-title').value = `${item.tag} – ${item.desc}`.slice(0, 200);
    document.getElementById('rfq-desc').value = `Material spec: ${item.spec}\nRequisition package: ${item.pkg} (${item.rev})\n`;
    document.getElementById('rfq-qty').value = item.qty;
    const catName = MTO_DISCIPLINE_TO_CATEGORY[item.discipline];
    const cat = categories.find((c) => c.kind === 'discipline' && c.name === catName);
    renderRfqCategories();
    if (cat) {
      const cb = document.querySelector(`#rfq-categories input[value="${cat.id}"]`);
      if (cb) cb.checked = true;
    }
    refreshMatches();
    document.getElementById('rfq-title').focus();
    toast(`MTO line ${item.tag} loaded. Add a product type to narrow the vendor list, then dispatch.`, 'info');
  };

  // ---------------- RFQ register & detail ----------------
  async function loadRfqs() {
    rfqs = (await api('GET', '/api/rfqs')).rfqs;
    renderRfqRegister();
    document.getElementById('kpi-open').textContent = rfqs.filter((r) => r.status === 'open').length;
    document.getElementById('kpi-closed').textContent = rfqs.filter((r) => r.status === 'closed').length;
    document.getElementById('kpi-quotes').textContent = rfqs.reduce((n, r) => n + r.quote_count, 0);
  }

  function renderRfqRegister() {
    const filter = document.getElementById('rfq-status-filter').value;
    const rows = filter === 'ALL' ? rfqs : rfqs.filter((r) => r.status === filter);
    const tbody = document.getElementById('rfq-register-body');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-slate-500">No RFQs yet. Describe a requirement above to send your first one.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => `
      <tr class="hover:bg-slate-800/40 transition">
        <td class="p-3 font-mono font-bold text-blue-400 whitespace-nowrap">${esc(r.ref)}</td>
        <td class="p-3 text-slate-200">${esc(r.title)} ${r.sealed ? '<i class="ph-bold ph-lock-simple text-slate-500" title="Sealed bids"></i>' : ''}</td>
        <td class="p-3 text-right font-mono">${esc(r.quantity)} ${esc(r.unit)}</td>
        <td class="p-3 font-mono text-[11px] whitespace-nowrap">${esc(fmtDate(r.closes_at, true))}</td>
        <td class="p-3 text-center font-mono"><span class="${r.quote_count ? 'text-emerald-400 font-bold' : 'text-slate-500'}">${r.quote_count}</span> / ${r.recipient_count}</td>
        <td class="p-3 text-slate-400">${esc(r.created_by_name)}</td>
        <td class="p-3">${statusPill(r.status)}</td>
        <td class="p-3 text-right"><button data-rfq="${r.id}" class="px-2.5 py-1 bg-slate-800 hover:bg-blue-600 text-slate-200 rounded-md text-[11px]">View</button></td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-rfq]').forEach((b) => b.addEventListener('click', () => openRfqDetail(Number(b.dataset.rfq))));
  }
  document.getElementById('rfq-status-filter').addEventListener('change', renderRfqRegister);

  function recipientStatus(r) {
    if (r.quoted) return statusPill('quoted');
    if (r.declined_at) return statusPill('declined');
    if (r.viewed_at) return statusPill('viewed');
    return statusPill('pending', 'not opened');
  }

  async function openRfqDetail(id) {
    let rfq;
    try { rfq = (await api('GET', `/api/rfqs/${id}`)).rfq; } catch (err) { toast(err.message, 'error'); return; }
    const quoted = rfq.recipients.filter((r) => r.quoted).length;
    const quotes = rfq.quotes;
    const currencies = new Set(quotes.map((q) => q.currency));
    const lowest = quotes.length && currencies.size === 1 ? Math.min(...quotes.map((q) => q.total_price)) : null;
    const fastest = quotes.length ? Math.min(...quotes.map((q) => q.lead_time_days)) : null;
    const canAward = isManager() && (rfq.status === 'closed' || (rfq.status === 'open' && !rfq.sealed));

    const body = document.getElementById('rfq-detail-body');
    body.innerHTML = `
      <div class="flex items-start justify-between pb-3 border-b border-slate-800 gap-3">
        <div>
          <div class="font-mono text-[11px] text-blue-400">${esc(rfq.ref)} · raised by ${esc(rfq.created_by_name)} on ${esc(fmtDate(rfq.created_at))}</div>
          <h3 class="text-base font-bold text-white">${esc(rfq.title)}</h3>
          <div class="mt-1 flex flex-wrap gap-1 items-center">${statusPill(rfq.status)} ${rfq.sealed ? '<span class="text-[10px] text-slate-400"><i class="ph-bold ph-lock-simple"></i> sealed</span>' : ''} ${categoryBadges(rfq.categories)}</div>
        </div>
        <button data-close class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800"><i class="ph-bold ph-x text-lg"></i></button>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div class="p-3 bg-industrial-950 rounded-lg border border-slate-800"><div class="text-slate-500 text-[10px] uppercase">Quantity</div><div class="font-mono font-bold text-white">${esc(rfq.quantity)} ${esc(rfq.unit)}</div></div>
        <div class="p-3 bg-industrial-950 rounded-lg border border-slate-800"><div class="text-slate-500 text-[10px] uppercase">Required by</div><div class="font-mono text-white">${esc(fmtDate(rfq.required_by))}</div></div>
        <div class="p-3 bg-industrial-950 rounded-lg border border-slate-800"><div class="text-slate-500 text-[10px] uppercase">Quote deadline</div><div class="font-mono text-amber-300">${esc(fmtDate(rfq.closes_at, true))}</div></div>
        <div class="p-3 bg-industrial-950 rounded-lg border border-slate-800"><div class="text-slate-500 text-[10px] uppercase">Responses</div><div class="font-mono text-white">${quoted} quoted / ${rfq.recipients.length} sent</div></div>
      </div>
      <div class="text-xs p-3 bg-industrial-950 rounded-lg border border-slate-800 text-slate-300 whitespace-pre-wrap">${esc(rfq.description)}${rfq.delivery_location ? `\n\nDelivery: ${esc(rfq.delivery_location)}` : ''}</div>

      <div class="space-y-2">
        <h4 class="text-sm font-bold text-white flex items-center gap-2"><i class="ph-bold ph-scales text-blue-400"></i> Quotation Comparison</h4>
        ${!rfq.quotes_visible ? `
          <div class="p-4 rounded-xl bg-industrial-950 border border-slate-800 text-xs text-slate-300 flex items-start gap-3">
            <i class="ph-bold ph-lock-key text-2xl text-amber-400 shrink-0"></i>
            <div><strong class="text-white">Sealed bidding in progress.</strong> ${quoted} of ${rfq.recipients.length} vendors have submitted. Prices are revealed when the deadline passes${isManager() ? ' or when you close bidding early' : ''}.</div>
          </div>` : !quotes.length ? '<div class="text-xs text-slate-500 p-3">No quotations were received.</div>' : `
          ${currencies.size > 1 ? '<div class="text-[11px] text-amber-300">Quotes are in different currencies; convert before comparing totals.</div>' : ''}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs text-slate-300">
              <thead class="bg-industrial-950 text-slate-400 uppercase font-semibold text-[10px] border-b border-slate-800 tracking-wider">
                <tr><th class="p-2.5">Vendor</th><th class="p-2.5 text-right">Unit Price</th><th class="p-2.5 text-right">Total</th><th class="p-2.5 text-center">Lead Time</th><th class="p-2.5">Incoterm</th><th class="p-2.5">Valid Until</th><th class="p-2.5">Notes</th><th class="p-2.5"></th></tr>
              </thead>
              <tbody class="divide-y divide-slate-800/60">
                ${quotes.map((q) => `
                  <tr class="${q.status === 'awarded' ? 'bg-emerald-950/30' : ''}">
                    <td class="p-2.5 font-semibold text-white">${q.status === 'awarded' ? '<i class="ph-bold ph-trophy text-amber-400"></i> ' : ''}${esc(q.company_name)}</td>
                    <td class="p-2.5 text-right font-mono">${esc(money(q.unit_price, q.currency))}</td>
                    <td class="p-2.5 text-right font-mono font-bold ${q.total_price === lowest ? 'text-emerald-400' : 'text-white'}">${esc(money(q.total_price, q.currency))}${q.total_price === lowest ? ' <span class="text-[9px] uppercase">lowest</span>' : ''}</td>
                    <td class="p-2.5 text-center font-mono ${q.lead_time_days === fastest ? 'text-emerald-400' : ''}">${esc(q.lead_time_days)} d</td>
                    <td class="p-2.5">${esc(q.incoterm || '—')}</td>
                    <td class="p-2.5 font-mono text-[11px]">${esc(fmtDate(q.valid_until))}</td>
                    <td class="p-2.5 text-[11px] text-slate-400 max-w-xs">${esc(q.notes)}</td>
                    <td class="p-2.5 text-right">${canAward ? `<button data-award="${q.id}" data-vendor-name="${esc(q.company_name)}" class="px-2.5 py-1 bg-slate-800 hover:bg-emerald-600 text-slate-200 rounded-md text-[11px] whitespace-nowrap">Award</button>` : q.status !== 'submitted' ? statusPill(q.status) : ''}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`}
      </div>

      <div class="space-y-2">
        <h4 class="text-sm font-bold text-white flex items-center gap-2"><i class="ph-bold ph-users text-blue-400"></i> Vendors Invited to Quote</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          ${rfq.recipients.map((r) => `
            <div class="p-2.5 rounded-lg bg-industrial-950 border border-slate-800 flex items-center justify-between gap-2">
              <div><div class="text-slate-200 font-medium">${esc(r.company_name)}</div>${r.decline_reason ? `<div class="text-[10px] text-slate-500">${esc(r.decline_reason)}</div>` : ''}</div>
              ${recipientStatus(r)}
            </div>`).join('')}
        </div>
      </div>

      ${isManager() && ['open', 'closed'].includes(rfq.status) ? `
        <div class="pt-3 border-t border-slate-800 flex flex-wrap justify-end gap-2 text-xs">
          <button data-cancel class="px-3 py-2 bg-slate-800 hover:bg-rose-900 text-slate-300 rounded-lg">Cancel RFQ</button>
          ${rfq.status === 'open' ? '<button data-close-bidding class="px-3 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg font-semibold">Close bidding now &amp; reveal quotes</button>' : ''}
        </div>` : ''}
    `;

    body.querySelector('[data-close]').onclick = () => ASTCO.closeModal('rfq-detail-modal');
    const act = async (fn, msg) => {
      try { await fn(); toast(msg, 'success'); await loadRfqs(); openRfqDetail(id); } catch (err) { toast(err.message, 'error'); }
    };
    body.querySelectorAll('[data-award]').forEach((b) => b.addEventListener('click', () => {
      if (!confirm(`Award ${rfq.ref} to ${b.dataset.vendorName}? All other bidders will be notified they were not selected.`)) return;
      act(() => api('POST', `/api/rfqs/${id}/award`, { quote_id: Number(b.dataset.award) }), `${rfq.ref} awarded to ${b.dataset.vendorName}.`);
    }));
    const closeBtn = body.querySelector('[data-close-bidding]');
    if (closeBtn) closeBtn.onclick = () => {
      if (!confirm('Close bidding now? Vendors will no longer be able to submit or revise quotes.')) return;
      act(() => api('POST', `/api/rfqs/${id}/close`), `${rfq.ref} closed for bidding.`);
    };
    const cancelBtn = body.querySelector('[data-cancel]');
    if (cancelBtn) cancelBtn.onclick = () => {
      if (!confirm(`Cancel ${rfq.ref}? This cannot be undone.`)) return;
      act(() => api('POST', `/api/rfqs/${id}/cancel`), `${rfq.ref} cancelled.`);
    };
    ASTCO.openModal('rfq-detail-modal');
  }

  // ---------------- Vendor network ----------------
  async function loadVendors() {
    vendors = (await api('GET', '/api/vendors')).vendors;
    document.getElementById('kpi-vendors').textContent = vendors.filter((v) => v.status === 'active').length;
    renderVendors();
  }

  function renderVendors() {
    const f = document.getElementById('vendor-filter').value.trim().toLowerCase();
    const rows = !f ? vendors : vendors.filter((v) =>
      [v.company_name, v.country, v.contact_email, ...v.categories.map((c) => c.name)].some((s) => (s || '').toLowerCase().includes(f)));
    const tbody = document.getElementById('vendors-body');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-500">${vendors.length ? 'No vendors match the filter.' : 'No registered vendors yet. Send an invitation above.'}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((v) => `
      <tr class="hover:bg-slate-800/40 transition">
        <td class="p-3"><div class="font-semibold text-white">${esc(v.company_name)}</div><div class="text-[11px] text-slate-500">${esc(v.contact_email)}${v.phone ? ' · ' + esc(v.phone) : ''}</div></td>
        <td class="p-3 text-slate-400">${esc(v.country || '—')}</td>
        <td class="p-3"><div class="flex flex-wrap gap-1 max-w-md">${categoryBadges(v.categories) || '<span class="text-slate-600">none declared</span>'}</div></td>
        <td class="p-3 text-center font-mono">${v.product_count}</td>
        <td class="p-3 text-center font-mono">${v.quote_count}</td>
        <td class="p-3">${statusPill(v.status)}</td>
        <td class="p-3 text-right whitespace-nowrap">
          <button data-catalog="${v.id}" class="px-2 py-1 bg-slate-800 hover:bg-blue-600 rounded text-[11px]">Catalog</button>
          ${isManager() ? `<button data-status="${v.id}" data-next="${v.status === 'active' ? 'suspended' : 'active'}" class="px-2 py-1 bg-slate-800 ${v.status === 'active' ? 'hover:bg-rose-800' : 'hover:bg-emerald-700'} rounded text-[11px]">${v.status === 'active' ? 'Suspend' : 'Reactivate'}</button>` : ''}
        </td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-catalog]').forEach((b) => b.addEventListener('click', () => openVendorCatalog(Number(b.dataset.catalog))));
    tbody.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
      const v = vendors.find((x) => x.id === Number(b.dataset.status));
      const next = b.dataset.next;
      if (next === 'suspended' && !confirm(`Suspend ${v.company_name}? They will be signed out and receive no further RFQs.`)) return;
      try {
        await api('POST', `/api/vendors/${v.id}/status`, { status: next });
        toast(`${v.company_name} ${next === 'active' ? 'reactivated' : 'suspended'}.`, 'success');
        loadVendors();
      } catch (err) { toast(err.message, 'error'); }
    }));
  }
  document.getElementById('vendor-filter').addEventListener('input', renderVendors);

  async function openVendorCatalog(vendorId) {
    const v = vendors.find((x) => x.id === vendorId);
    let products;
    try { products = (await api('GET', `/api/vendors/${vendorId}/products`)).products; } catch (err) { toast(err.message, 'error'); return; }
    const body = document.getElementById('vendor-catalog-body');
    body.innerHTML = `
      <div class="flex items-start justify-between pb-3 border-b border-slate-800">
        <div>
          <h3 class="text-base font-bold text-white">${esc(v.company_name)} · Product Catalog</h3>
          <p class="text-[11px] text-slate-400">Confidential vendor pricing. Visible to ASTCO procurement only.</p>
        </div>
        <button data-close class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800"><i class="ph-bold ph-x text-lg"></i></button>
      </div>
      ${isManager() ? `
        <details class="text-xs">
          <summary class="cursor-pointer text-blue-400">Edit supply categories for this vendor</summary>
          <div class="mt-3 space-y-3" id="vendor-cat-editor">${categoryPicker(categories, 'vccat', new Set(v.categories.map((c) => c.id)))}</div>
          <button data-save-cats class="mt-3 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-semibold">Save categories</button>
        </details>` : ''}
      ${productTable(products, false)}
    `;
    body.querySelector('[data-close]').onclick = () => ASTCO.closeModal('vendor-catalog-modal');
    const save = body.querySelector('[data-save-cats]');
    if (save) save.onclick = async () => {
      try {
        await api('PUT', `/api/vendors/${vendorId}/categories`, { category_ids: checkedIds(body.querySelector('#vendor-cat-editor'), 'vccat') });
        toast('Vendor categories updated.', 'success');
        loadVendors();
      } catch (err) { toast(err.message, 'error'); }
    };
    ASTCO.openModal('vendor-catalog-modal');
  }

  function productTable(products, showVendor) {
    if (!products.length) return '<div class="text-xs text-slate-500 p-4 text-center">No products listed.</div>';
    return `
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs text-slate-300">
          <thead class="bg-industrial-950 text-slate-400 uppercase font-semibold text-[10px] border-b border-slate-800 tracking-wider">
            <tr><th class="p-2.5">Product</th>${showVendor ? '<th class="p-2.5">Vendor</th>' : ''}<th class="p-2.5">Category</th><th class="p-2.5 text-right">Unit Price</th><th class="p-2.5 text-center">MOQ</th><th class="p-2.5 text-center">Lead Time</th></tr>
          </thead>
          <tbody class="divide-y divide-slate-800/60">${products.map((p) => productRow(p, showVendor)).join('')}</tbody>
        </table>
      </div>`;
  }

  function productRow(p, showVendor) {
    return `
      <tr class="hover:bg-slate-800/40 ${p.active ? '' : 'opacity-50'}">
        <td class="p-2.5"><div class="font-semibold text-white">${esc(p.name)} ${p.sku ? `<span class="font-mono text-[10px] text-slate-500">${esc(p.sku)}</span>` : ''}</div><div class="text-[11px] text-slate-500 max-w-sm">${esc(p.description)}</div></td>
        ${showVendor ? `<td class="p-2.5 text-slate-300">${esc(p.company_name)}</td>` : ''}
        <td class="p-2.5 text-slate-400">${esc(p.category_name || '—')}</td>
        <td class="p-2.5 text-right font-mono font-bold text-white whitespace-nowrap">${esc(money(p.unit_price, p.currency))} <span class="text-slate-500 font-normal">/ ${esc(p.unit)}</span></td>
        <td class="p-2.5 text-center font-mono">${esc(p.moq)}</td>
        <td class="p-2.5 text-center font-mono">${esc(p.lead_time_days)} d</td>
      </tr>`;
  }

  let catalogTimer = null;
  async function searchCatalog() {
    const q = document.getElementById('catalog-q').value;
    const cat = document.getElementById('catalog-cat').value;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (cat) params.set('category_id', cat);
    try {
      const { products } = await api('GET', '/api/catalog?' + params.toString());
      const tbody = document.getElementById('catalog-body');
      tbody.innerHTML = products.length ? products.map((p) => productRow(p, true)).join('')
        : '<tr><td colspan="6" class="p-6 text-center text-slate-500">No matching products in vendor catalogs.</td></tr>';
    } catch (err) { toast(err.message, 'error'); }
  }
  document.getElementById('catalog-q').addEventListener('input', () => { clearTimeout(catalogTimer); catalogTimer = setTimeout(searchCatalog, 250); });
  document.getElementById('catalog-cat').addEventListener('change', searchCatalog);

  function fillCategorySelects() {
    const groups = groupByKind(categories);
    document.getElementById('catalog-cat').innerHTML = '<option value="">All categories</option>' + Object.keys(groups).map((k) =>
      `<optgroup label="${esc(kindLabel(k))}">${groups[k].map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
    document.getElementById('cat-kind-options').innerHTML = Object.keys(groups).map((k) => `<option value="${esc(k)}">`).join('');
    document.getElementById('inv-categories').innerHTML = categoryPicker(categories, 'invcat');
  }

  // ---------------- Invitations ----------------
  function invitationState(i) {
    if (i.used_at) return 'used';
    if (i.revoked_at) return 'revoked';
    if (i.expires_at < new Date().toISOString()) return 'expired';
    return 'pending';
  }

  async function loadInvitations() {
    if (!isManager()) return;
    const { invitations } = await api('GET', '/api/invitations');
    const tbody = document.getElementById('invitations-body');
    tbody.innerHTML = invitations.length ? invitations.map((i) => {
      const state = invitationState(i);
      return `
        <tr>
          <td class="p-2 text-slate-200">${esc(i.email)}</td>
          <td class="p-2 text-slate-400">${esc(ROLE_LABELS[i.role] || i.role)}</td>
          <td class="p-2 text-slate-400">${esc(i.company_name || '—')}</td>
          <td class="p-2">${statusPill(state)}</td>
          <td class="p-2 text-right">${state === 'pending' ? `<button data-revoke="${i.id}" class="text-[10px] text-rose-400 hover:text-rose-300 underline">Revoke</button>` : ''}</td>
        </tr>`;
    }).join('') : '<tr><td colspan="5" class="p-6 text-center text-slate-500">No invitations sent yet.</td></tr>';
    tbody.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('POST', `/api/invitations/${b.dataset.revoke}/revoke`); toast('Invitation revoked.', 'success'); loadInvitations(); }
      catch (err) { toast(err.message, 'error'); }
    }));
  }

  const invRole = document.getElementById('inv-role');
  invRole.addEventListener('change', () => {
    document.getElementById('inv-vendor-fields').classList.toggle('hidden', invRole.value !== 'vendor');
  });

  document.getElementById('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = invRole.value;
    try {
      const res = await api('POST', '/api/invitations', {
        email: document.getElementById('inv-email').value,
        role,
        company_name: role === 'vendor' ? document.getElementById('inv-company').value : '',
        category_ids: role === 'vendor' ? checkedIds(document.getElementById('inv-categories'), 'invcat') : [],
      });
      const link = window.location.origin + res.register_path;
      const out = document.getElementById('invite-result');
      out.innerHTML = `
        <div class="font-semibold">Invitation created for ${esc(res.invitation.email)}.</div>
        <div class="text-[11px] text-emerald-300/80">Send this single-use link to the invitee. It is shown only once and expires in 7 days.</div>
        <div class="flex gap-2"><input class="field font-mono !text-[11px]" readonly value="${esc(link)}"><button type="button" data-copy class="px-3 bg-emerald-700 hover:bg-emerald-600 rounded-lg text-white whitespace-nowrap"><i class="ph-bold ph-copy"></i> Copy</button></div>`;
      out.classList.remove('hidden');
      out.querySelector('[data-copy]').onclick = async () => {
        try { await navigator.clipboard.writeText(link); toast('Link copied.', 'success'); }
        catch { out.querySelector('input').select(); toast('Press Ctrl+C to copy the selected link.', 'info'); }
      };
      document.getElementById('inv-email').value = '';
      document.getElementById('inv-company').value = '';
      document.getElementById('inv-categories').innerHTML = categoryPicker(categories, 'invcat');
      loadInvitations();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.getElementById('category-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { category } = await api('POST', '/api/categories', {
        kind: document.getElementById('cat-kind').value,
        name: document.getElementById('cat-name').value,
      });
      categories.push(category);
      categories.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
      fillCategorySelects();
      renderRfqCategories(document.getElementById('cat-filter').value);
      ASTCO.closeModal('category-modal');
      e.target.reset();
      toast(`Category "${category.name}" added under ${kindLabel(category.kind)}.`, 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  document.addEventListener('astco:tab', (e) => {
    if (e.detail === 'vendors') { loadVendors(); loadInvitations(); searchCatalog(); }
    if (e.detail === 'rfq') loadRfqs();
  });

  // ---------------- boot ----------------
  (async () => {
    me = await ASTCO.requireUser(['admin', 'procurement_manager', 'procurement_staff']);
    if (!me) return;
    document.getElementById('current-user-name').textContent = me.full_name;
    document.getElementById('current-user-role').textContent = ROLE_LABELS[me.role] || me.role;
    if (!isManager()) document.getElementById('manager-only-panels').classList.add('hidden');
    if (me.role !== 'admin') document.querySelectorAll('[data-admin-only]').forEach((o) => o.remove());
    categories = (await api('GET', '/api/categories')).categories;
    fillCategorySelects();
    resetRfqForm();
    await Promise.all([loadRfqs(), loadVendors()]);
    setInterval(() => { if (!document.hidden) loadRfqs(); }, 60000);
  })();
})();
