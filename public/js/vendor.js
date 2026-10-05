(function () {
  const { esc, api, toast, money, fmtDate, statusPill, categoryBadges, kindLabel, groupByKind, categoryPicker, checkedIds, openModal, closeModal } = ASTCO;
  let categories = [];
  let products = [];

  function switchTab(tab) {
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    ['inbox', 'catalog', 'categories', 'profile'].forEach((t) => document.getElementById('tab-' + t).classList.toggle('hidden', t !== tab));
  }
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  function rfqState(r) {
    if (r.outcome === 'awarded') return statusPill('awarded', 'Awarded to you');
    if (r.outcome === 'not_awarded') return statusPill('not_awarded', 'Not awarded');
    if (r.outcome === 'cancelled') return statusPill('cancelled');
    if (r.status === 'closed') return statusPill('closed', 'Closed – under evaluation');
    if (r.declined_at) return statusPill('declined');
    if (r.quote_id) return statusPill('quoted', 'Quote submitted');
    if (!r.viewed_at) return statusPill('new', 'New');
    return statusPill('open', 'Awaiting your quote');
  }

  async function loadRfqs() {
    const { rfqs } = await api('GET', '/api/vendor/rfqs');
    const unread = rfqs.filter((r) => !r.viewed_at && r.status === 'open').length;
    const badge = document.getElementById('unread-badge');
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);
    const tbody = document.getElementById('rfq-body');
    if (!rfqs.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-500">No RFQs yet. Make sure your supply categories and products are up to date so ASTCO can route requests to you.</td></tr>';
      return;
    }
    tbody.innerHTML = rfqs.map((r) => `
      <tr class="hover:bg-slate-800/40 transition ${!r.viewed_at && r.status === 'open' ? 'bg-blue-950/20' : ''}">
        <td class="p-3 font-mono font-bold text-emerald-400 whitespace-nowrap">${esc(r.ref)}</td>
        <td class="p-3 text-slate-200">${esc(r.title)}</td>
        <td class="p-3 text-right font-mono">${esc(r.quantity)} ${esc(r.unit)}</td>
        <td class="p-3 font-mono text-[11px] whitespace-nowrap">${esc(fmtDate(r.closes_at, true))}</td>
        <td class="p-3 font-mono">${r.quote_id ? esc(money(r.my_total, r.my_currency)) : '—'}</td>
        <td class="p-3">${rfqState(r)}</td>
        <td class="p-3 text-right"><button data-open="${r.id}" class="px-2.5 py-1 bg-slate-800 hover:bg-emerald-600 text-slate-200 rounded-md text-[11px]">Open</button></td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openRfq(Number(b.dataset.open))));
  }

  async function openRfq(id) {
    const { rfq } = await api('GET', `/api/vendor/rfqs/${id}`);
    const q = rfq.my_quote;
    const canQuote = rfq.status === 'open';
    const body = document.getElementById('rfq-modal-body');
    body.innerHTML = `
      <div class="flex items-start justify-between pb-3 border-b border-slate-800 gap-3">
        <div>
          <div class="font-mono text-[11px] text-emerald-400">${esc(rfq.ref)}</div>
          <h3 class="text-base font-bold text-white">${esc(rfq.title)}</h3>
          <div class="mt-1">${rfqState({ ...rfq, quote_id: q && q.id, viewed_at: 1 })}</div>
        </div>
        <button data-close class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800"><i class="ph-bold ph-x text-lg"></i></button>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div class="p-3 bg-industrial-950 rounded-lg border border-slate-800"><div class="text-slate-500 text-[10px] uppercase">Quantity</div><div class="font-mono font-bold text-white">${esc(rfq.quantity)} ${esc(rfq.unit)}</div></div>
        <div class="p-3 bg-industrial-950 rounded-lg border border-slate-800"><div class="text-slate-500 text-[10px] uppercase">Required by</div><div class="font-mono text-white">${esc(fmtDate(rfq.required_by))}</div></div>
        <div class="p-3 bg-industrial-950 rounded-lg border border-slate-800 col-span-2"><div class="text-slate-500 text-[10px] uppercase">Quote deadline</div><div class="font-mono text-amber-300">${esc(fmtDate(rfq.closes_at, true))}</div></div>
      </div>
      ${rfq.delivery_location ? `<div class="text-xs text-slate-400"><i class="ph-bold ph-map-pin text-amber-400"></i> Delivery: <span class="text-slate-200">${esc(rfq.delivery_location)}</span></div>` : ''}
      <div class="text-xs">
        <div class="text-slate-500 text-[10px] uppercase mb-1">Requirement description</div>
        <div class="p-3 bg-industrial-950 rounded-lg border border-slate-800 text-slate-200 whitespace-pre-wrap">${esc(rfq.description)}</div>
      </div>
      <div class="flex flex-wrap gap-1">${categoryBadges(rfq.categories)}</div>
      ${canQuote ? `
      <form id="quote-form" class="space-y-3 text-xs pt-3 border-t border-slate-800">
        <h4 class="font-bold text-white text-sm">${q ? 'Revise your quotation' : 'Submit your quotation'}</h4>
        <div class="grid grid-cols-3 gap-3">
          <div><label class="label">Unit price</label><input class="field font-mono" name="unit_price" type="number" min="0" step="0.01" required value="${q ? esc(q.unit_price) : ''}"></div>
          <div><label class="label">Currency</label><input class="field font-mono uppercase" name="currency" maxlength="3" required value="${esc(q ? q.currency : 'USD')}"></div>
          <div><label class="label">Total (${esc(rfq.quantity)} ${esc(rfq.unit)})</label><input class="field font-mono" name="total_price" type="number" min="0" step="0.01" value="${q ? esc(q.total_price) : ''}" placeholder="auto"></div>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div><label class="label">Lead time (days)</label><input class="field font-mono" name="lead_time_days" type="number" min="0" step="1" required value="${q ? esc(q.lead_time_days) : ''}"></div>
          <div><label class="label">Quote valid until</label><input class="field font-mono" name="valid_until" type="date" value="${q && q.valid_until ? esc(q.valid_until.slice(0, 10)) : ''}"></div>
          <div><label class="label">Incoterm</label><input class="field" name="incoterm" maxlength="40" placeholder="e.g. DAP Site" value="${q ? esc(q.incoterm) : ''}"></div>
        </div>
        <div><label class="label">Notes / technical clarifications</label><textarea class="field" name="notes" rows="2" maxlength="3000">${q ? esc(q.notes) : ''}</textarea></div>
        <div class="flex justify-between gap-2">
          <button type="button" data-decline class="px-3 py-2 bg-slate-800 hover:bg-rose-900 text-slate-300 rounded-lg">${rfq.declined_at ? 'Declined' : 'Decline to quote'}</button>
          <button type="submit" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-semibold">${q ? 'Update quotation' : 'Submit quotation'}</button>
        </div>
      </form>` : q ? `
      <div class="pt-3 border-t border-slate-800 text-xs">
        <h4 class="font-bold text-white text-sm mb-2">Your submitted quotation</h4>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono">
          <div>Unit: <span class="text-white">${esc(money(q.unit_price, q.currency))}</span></div>
          <div>Total: <span class="text-white">${esc(money(q.total_price, q.currency))}</span></div>
          <div>Lead: <span class="text-white">${esc(q.lead_time_days)} days</span></div>
          <div>${esc(q.incoterm || '')}</div>
        </div>
      </div>` : ''}
    `;
    body.querySelector('[data-close]').onclick = () => { closeModal('rfq-modal'); loadRfqs(); };
    const form = body.querySelector('#quote-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = Object.fromEntries(fd.entries());
        payload.unit_price = Number(payload.unit_price);
        payload.lead_time_days = Number(payload.lead_time_days);
        payload.total_price = payload.total_price === '' ? undefined : Number(payload.total_price);
        try {
          await api('PUT', `/api/vendor/rfqs/${rfq.id}/quote`, payload);
          toast(`Quotation for ${rfq.ref} saved.`, 'success');
          closeModal('rfq-modal');
          loadRfqs();
        } catch (err) { toast(err.message, 'error'); }
      });
      body.querySelector('[data-decline]').addEventListener('click', async () => {
        const reason = prompt('Optional: reason for declining (e.g. not in stock, outside scope)') ;
        if (reason === null) return;
        try {
          await api('POST', `/api/vendor/rfqs/${rfq.id}/decline`, { reason });
          toast(`You declined ${rfq.ref}.`, 'info');
          closeModal('rfq-modal');
          loadRfqs();
        } catch (err) { toast(err.message, 'error'); }
      });
    }
    openModal('rfq-modal');
  }

  async function loadProducts() {
    products = (await api('GET', '/api/vendor/products')).products;
    const tbody = document.getElementById('product-body');
    if (!products.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="p-8 text-center text-slate-500">No products yet. Add the items you supply with your prices.</td></tr>';
      return;
    }
    tbody.innerHTML = products.map((p) => `
      <tr class="hover:bg-slate-800/40 transition">
        <td class="p-3 font-mono text-slate-400">${esc(p.sku || '—')}</td>
        <td class="p-3"><div class="font-semibold text-white">${esc(p.name)}</div><div class="text-[11px] text-slate-500 max-w-xs truncate">${esc(p.description)}</div></td>
        <td class="p-3 text-slate-300">${p.category_name ? esc(p.category_name) : '—'}</td>
        <td class="p-3 text-right font-mono font-bold text-white">${esc(money(p.unit_price, p.currency))}</td>
        <td class="p-3">${esc(p.unit)}</td>
        <td class="p-3 text-center font-mono">${esc(p.moq)}</td>
        <td class="p-3 text-center font-mono">${esc(p.lead_time_days)} d</td>
        <td class="p-3">${p.active ? statusPill('active') : statusPill('cancelled', 'inactive')}</td>
        <td class="p-3 text-right whitespace-nowrap">
          <button data-edit="${p.id}" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-[11px]"><i class="ph-bold ph-pencil-simple"></i></button>
          <button data-del="${p.id}" class="px-2 py-1 bg-slate-800 hover:bg-rose-800 rounded text-[11px]"><i class="ph-bold ph-trash"></i></button>
        </td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openProduct(products.find((p) => p.id === Number(b.dataset.edit)))));
    tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const p = products.find((x) => x.id === Number(b.dataset.del));
      if (!confirm(`Delete "${p.name}" from your catalog?`)) return;
      try { await api('DELETE', `/api/vendor/products/${p.id}`); toast('Product deleted.', 'success'); loadProducts(); }
      catch (err) { toast(err.message, 'error'); }
    }));
  }

  function fillCategorySelect() {
    const groups = groupByKind(categories);
    document.getElementById('p-cat').innerHTML = '<option value="">— Uncategorised —</option>' + Object.keys(groups).map((k) =>
      `<optgroup label="${esc(kindLabel(k))}">${groups[k].map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
  }

  window.openProduct = function (p) {
    document.getElementById('product-modal-title').textContent = p ? 'Edit product' : 'Add product';
    document.getElementById('p-id').value = p ? p.id : '';
    document.getElementById('p-sku').value = p ? p.sku : '';
    document.getElementById('p-name').value = p ? p.name : '';
    document.getElementById('p-desc').value = p ? p.description : '';
    document.getElementById('p-cat').value = p && p.category_id ? p.category_id : '';
    document.getElementById('p-price').value = p ? p.unit_price : '';
    document.getElementById('p-cur').value = p ? p.currency : 'USD';
    document.getElementById('p-unit').value = p ? p.unit : 'EA';
    document.getElementById('p-moq').value = p ? p.moq : 1;
    document.getElementById('p-lead').value = p ? p.lead_time_days : 0;
    document.getElementById('p-active').checked = p ? !!p.active : true;
    openModal('product-modal');
  };

  document.getElementById('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('p-id').value;
    const cat = document.getElementById('p-cat').value;
    const payload = {
      sku: document.getElementById('p-sku').value,
      name: document.getElementById('p-name').value,
      description: document.getElementById('p-desc').value,
      category_id: cat ? Number(cat) : null,
      unit_price: Number(document.getElementById('p-price').value),
      currency: document.getElementById('p-cur').value,
      unit: document.getElementById('p-unit').value,
      moq: Number(document.getElementById('p-moq').value),
      lead_time_days: Number(document.getElementById('p-lead').value),
      active: document.getElementById('p-active').checked,
    };
    try {
      await api(id ? 'PUT' : 'POST', id ? `/api/vendor/products/${id}` : '/api/vendor/products', payload);
      toast('Product saved.', 'success');
      closeModal('product-modal');
      loadProducts();
    } catch (err) { toast(err.message, 'error'); }
  });

  let profile = null;
  async function loadProfile() {
    profile = (await api('GET', '/api/vendor/profile')).vendor;
    document.getElementById('vendor-name').textContent = profile.company_name;
    document.getElementById('pf-company').value = profile.company_name;
    document.getElementById('pf-email').value = profile.contact_email;
    document.getElementById('pf-country').value = profile.country;
    document.getElementById('pf-phone').value = profile.phone;
    document.getElementById('category-picker').innerHTML = categoryPicker(categories, 'vcat', new Set(profile.categories.map((c) => c.id)));
  }

  window.saveCategories = async function () {
    try {
      await api('PUT', '/api/vendor/categories', { category_ids: checkedIds(document.getElementById('category-picker'), 'vcat') });
      toast('Supply categories saved. Matching RFQs will now be routed to you.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };

  document.getElementById('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/vendor/profile', { country: document.getElementById('pf-country').value, phone: document.getElementById('pf-phone').value });
      toast('Profile saved.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal('product-modal'); closeModal('rfq-modal'); } });

  (async () => {
    const user = await ASTCO.requireUser(['vendor']);
    if (!user) return;
    document.getElementById('user-name').textContent = user.full_name;
    categories = (await api('GET', '/api/categories')).categories;
    fillCategorySelect();
    await Promise.all([loadProfile(), loadRfqs(), loadProducts()]);
    setInterval(loadRfqs, 60000);
  })();
})();
