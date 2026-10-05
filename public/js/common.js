// Shared client helpers. All server data is rendered through esc() before touching innerHTML.
(function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  }

  async function api(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body || {});
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      window.location.href = '/login.html';
      throw new Error('Session expired.');
    }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
    return data;
  }

  function toast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'fixed bottom-5 right-5 z-[60] flex flex-col gap-2.5 pointer-events-none';
      document.body.appendChild(container);
    }
    const styles = {
      success: ['bg-emerald-950/95 border-emerald-600 text-emerald-200', 'ph-check-circle text-emerald-400'],
      warning: ['bg-amber-950/95 border-amber-600 text-amber-200', 'ph-warning text-amber-400'],
      error: ['bg-rose-950/95 border-rose-600 text-rose-200', 'ph-x-circle text-rose-400'],
      info: ['bg-slate-900/95 border-slate-700 text-slate-200', 'ph-info text-blue-400'],
    }[type] || [];
    const el = document.createElement('div');
    el.className = `${styles[0]} backdrop-blur-md border px-4 py-3 rounded-xl shadow-2xl flex items-center gap-3 text-xs pointer-events-auto max-w-sm transition-all duration-300`;
    el.innerHTML = `<i class="ph-bold ${styles[1]} text-lg shrink-0"></i><div class="flex-1 font-medium">${esc(message)}</div>
      <button class="text-slate-400 hover:text-white p-0.5 rounded hover:bg-white/10"><i class="ph-bold ph-x"></i></button>`;
    el.querySelector('button').onclick = () => el.remove();
    container.appendChild(el);
    setTimeout(() => { el.classList.add('opacity-0'); setTimeout(() => el.remove(), 350); }, 5000);
  }

  async function requireUser(roles) {
    try {
      const { user } = await api('GET', '/api/auth/me');
      if (!roles.includes(user.role)) {
        window.location.href = user.role === 'vendor' ? '/vendor.html' : '/procurement.html';
        return null;
      }
      return user;
    } catch {
      window.location.href = '/login.html';
      return null;
    }
  }

  async function logout() {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    window.location.href = '/login.html';
  }

  function money(amount, currency) {
    if (amount === null || amount === undefined) return '—';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(amount);
    } catch {
      return `${currency || ''} ${Number(amount).toFixed(2)}`;
    }
  }

  function fmtDate(iso, withTime = false) {
    if (!iso) return '—';
    const d = new Date(iso);
    return withTime ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }

  const KIND_LABELS = { discipline: 'Discipline', product_type: 'Product Type', service: 'Service' };
  function kindLabel(kind) {
    return KIND_LABELS[kind] || kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function groupByKind(categories) {
    const groups = {};
    for (const c of categories) (groups[c.kind] ||= []).push(c);
    return groups;
  }

  // Renders grouped checkbox chips. name = input name; selected = Set of ids.
  function categoryPicker(categories, name, selected = new Set()) {
    const groups = groupByKind(categories);
    return Object.keys(groups).map((kind) => `
      <div class="space-y-1.5">
        <div class="text-[10px] uppercase tracking-wider font-semibold text-slate-500">${esc(kindLabel(kind))}</div>
        <div class="flex flex-wrap gap-1.5">
          ${groups[kind].map((c) => `<label class="chip-toggle"><input type="checkbox" name="${esc(name)}" value="${c.id}" ${selected.has(c.id) ? 'checked' : ''}><span>${esc(c.name)}</span></label>`).join('')}
        </div>
      </div>`).join('');
  }

  function checkedIds(root, name) {
    return [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => Number(i.value));
  }

  function categoryBadges(categories) {
    return categories.map((c) => `<span class="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 border border-slate-700 font-sans" title="${esc(kindLabel(c.kind))}">${esc(c.name)}</span>`).join(' ');
  }

  const STATUS_STYLES = {
    open: 'bg-blue-950 text-blue-300 border-blue-800',
    closed: 'bg-amber-950 text-amber-300 border-amber-800',
    awarded: 'bg-emerald-950 text-emerald-300 border-emerald-800',
    cancelled: 'bg-slate-800 text-slate-400 border-slate-700',
    not_awarded: 'bg-slate-800 text-slate-400 border-slate-700',
    active: 'bg-emerald-950 text-emerald-300 border-emerald-800',
    suspended: 'bg-rose-950 text-rose-300 border-rose-800',
    pending: 'bg-amber-950 text-amber-300 border-amber-800',
    used: 'bg-emerald-950 text-emerald-300 border-emerald-800',
    revoked: 'bg-slate-800 text-slate-400 border-slate-700',
    expired: 'bg-slate-800 text-slate-400 border-slate-700',
    quoted: 'bg-emerald-950 text-emerald-300 border-emerald-800',
    declined: 'bg-rose-950 text-rose-300 border-rose-800',
    new: 'bg-blue-950 text-blue-300 border-blue-800',
    viewed: 'bg-slate-800 text-slate-300 border-slate-700',
  };
  function statusPill(status, label) {
    const cls = STATUS_STYLES[status] || STATUS_STYLES.cancelled;
    return `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-sans font-semibold border whitespace-nowrap ${cls}">${esc(label || status.replace(/_/g, ' '))}</span>`;
  }

  function openModal(id) { const el = document.getElementById(id); if (el) { el.classList.remove('hidden'); el.classList.add('flex'); } }
  function closeModal(id) { const el = document.getElementById(id); if (el) { el.classList.add('hidden'); el.classList.remove('flex'); } }

  // datetime-local value for "now + hours"
  function localInputValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  window.ASTCO = {
    esc, api, toast, requireUser, logout, money, fmtDate, kindLabel, groupByKind, categoryPicker,
    checkedIds, categoryBadges, statusPill, openModal, closeModal, localInputValue,
  };
})();
