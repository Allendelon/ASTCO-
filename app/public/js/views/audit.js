import { h, api, fmtTime, ltr, t, sep } from '../lib.js';
import { dataTable } from '../ui/table.js';
import { actionButton } from '../ui/controls.js';

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
    const table = dataTable({
        caption: t('audit.title'),
        columns: [
            { id: 'seq', header: t('audit.col.seq'), primary: true, numeric: true, className: 'mono', cell: (a) => a.chain_seq },
            { id: 'time', header: t('audit.col.time'), numeric: true, className: 'small', cell: (a) => fmtTime(a.event_timestamp) },
            { id: 'by', header: t('audit.col.by'), className: 'small',
              cell: (a) => [a.actor_name || t('common.system'), a.actor_ip ? h('div', { class: 'muted' }, ltr(a.actor_ip)) : null] },
            { id: 'event', header: t('audit.col.event'), cell: (a) => label('action', a.action, a.action) },
            { id: 'details', header: t('audit.col.details'), className: 'small', cell: (a) => describe(a.details) },
            { id: 'hash', header: t('audit.col.hash'), className: 'hash', priority: 'low',
              cell: (a) => h('span', { title: a.current_hash }, `${a.current_hash.slice(0, 12)}…`) },
        ],
    });
    const more = actionButton({ label: t('audit.more'), class: 'hidden', onClick: () => load() });
    const result = h('p', { class: 'small', style: 'margin:0', role: 'status' });
    let last = null;

    async function load() {
        const rows = await api('GET', `/projects/${pid}/audit${last ? `?before=${last}` : ''}`);
        table.appendRows(rows);
        last = rows.at(-1)?.chain_seq ?? last;
        more.classList.toggle('hidden', rows.length < 200);
    }
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
        table.el,
        h('div', { style: 'margin-top:12px' }, more));
}
