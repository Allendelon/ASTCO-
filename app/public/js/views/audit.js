import { h, api, toast, fmtTime, ltr, t, sep } from '../lib.js';

// Detail keys that are internal identifiers, not useful to a reader.
const HIDDEN_DETAILS = ['sha256', 'responder_org_id', 'revision_id'];

const label = (prefix, key, fallback) => {
    const s = t(`${prefix}.${key}`);
    return s === `${prefix}.${key}` ? fallback : s;
};

function describe(details) {
    return Object.entries(details || {})
        .filter(([k]) => !HIDDEN_DETAILS.includes(k))
        .flatMap(([k, v], i) => [i ? sep() : null, `${label('detail', k, k.replace(/_/g, ' '))}: `, ltr(String(v), '')]);
}

export async function auditView(ctx) {
    const { pid } = ctx;
    const tbody = h('tbody');
    const more = h('button', { class: 'hidden' }, t('audit.more'));
    const result = h('p', { class: 'small', style: 'margin:0', role: 'status' });
    let last = null;

    async function load() {
        const rows = await api('GET', `/projects/${pid}/audit${last ? `?before=${last}` : ''}`);
        tbody.append(...rows.map((a) => h('tr', null,
            h('td', { class: 'mono num' }, a.chain_seq),
            h('td', { class: 'small num' }, fmtTime(a.event_timestamp)),
            h('td', { class: 'small' }, a.actor_name || t('common.system'), a.actor_ip ? h('div', { class: 'muted' }, ltr(a.actor_ip)) : null),
            h('td', null, label('action', a.action, a.action)),
            h('td', { class: 'small' }, describe(a.details)),
            h('td', { class: 'hash', title: a.current_hash }, `${a.current_hash.slice(0, 12)}…`))));
        last = rows.at(-1)?.chain_seq ?? last;
        more.classList.toggle('hidden', rows.length < 200);
    }
    more.addEventListener('click', () => load().catch((e) => toast(e.message, 'error')));
    await load();

    const verify = h('button', { onclick: async () => {
        verify.disabled = true;
        result.textContent = t('audit.checking');
        try {
            const v = await api('POST', `/projects/${pid}/audit/verify`, {});
            result.className = `small ${v.intact ? '' : 'overdue'}`;
            result.textContent = v.intact ? t('audit.intact') : t('audit.broken', { seq: v.first_broken_seq });
        } catch (err) { result.textContent = err.message; } finally { verify.disabled = false; }
    } }, t('audit.verify'));

    return h('div', null,
        h('div', { class: 'page-head' },
            h('div', null, h('h1', null, t('audit.title')),
                h('p', null, t('audit.intro'))),
            h('div', { class: 'actions' }, verify)),
        h('div', { style: 'margin-bottom:12px' }, result),
        h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ['seq', 'time', 'by', 'event', 'details', 'hash'].map((x) => h('th', null, t(`audit.col.${x}`))))),
            tbody)),
        h('div', { style: 'margin-top:12px' }, more));
}
