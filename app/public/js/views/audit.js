import { h, render, api, toast, fmtTime } from '../lib.js';

const ACTION_LABEL = {
    REVISION_UPLOADED: 'Uploaded revision',
    REVISION_STATUS_CHANGED: 'Changed status',
    REVISION_DELETED: 'Deleted WIP revision',
    DOCUMENT_DOWNLOADED: 'Opened file',
    TRANSMITTAL_ISSUED: 'Issued transmittal',
    TRANSMITTAL_UNDER_REVIEW: 'Review started',
    TRANSMITTAL_CLOSED: 'Closed transmittal',
    CODE_STAMPED: 'Stamped review code',
    INSPECTION_REQUESTED: 'Requested inspection',
    INSPECTION_INSPECTED_PASS: 'Inspection passed',
    INSPECTION_INSPECTED_FAIL: 'Inspection failed',
};

function describe(details) {
    return Object.entries(details || {})
        .filter(([k]) => !['sha256', 'responder_org_id', 'revision_id'].includes(k))
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(', ');
}

export async function auditView(ctx) {
    const { pid } = ctx;
    const tbody = h('tbody');
    const more = h('button', { class: 'hidden' }, 'Load older entries');
    const result = h('p', { class: 'small', style: 'margin:0', role: 'status' });
    let last = null;

    async function load() {
        const rows = await api('GET', `/projects/${pid}/audit${last ? `?before=${last}` : ''}`);
        tbody.append(...rows.map((a) => h('tr', null,
            h('td', { class: 'mono num' }, a.chain_seq),
            h('td', { class: 'small num' }, fmtTime(a.event_timestamp)),
            h('td', { class: 'small' }, a.actor_name || 'System', a.actor_ip ? h('div', { class: 'muted mono' }, a.actor_ip) : null),
            h('td', null, ACTION_LABEL[a.action] || a.action),
            h('td', { class: 'small' }, describe(a.details)),
            h('td', { class: 'hash', title: a.current_hash }, `${a.current_hash.slice(0, 12)}…`))));
        last = rows.at(-1)?.chain_seq ?? last;
        more.classList.toggle('hidden', rows.length < 200);
    }
    more.addEventListener('click', () => load().catch((e) => toast(e.message, 'error')));
    await load();

    const verify = h('button', { onclick: async () => {
        verify.disabled = true;
        result.textContent = 'Checking every entry…';
        try {
            const v = await api('POST', `/projects/${pid}/audit/verify`, {});
            result.className = `small ${v.intact ? '' : 'overdue'}`;
            result.textContent = v.intact
                ? 'Every entry matches its hash and links to the one before it. Nothing has been altered or removed.'
                : `The chain breaks at entry ${v.first_broken_seq}. That entry or the one before it was altered or removed. Report this to your security team.`;
        } catch (err) { result.textContent = err.message; } finally { verify.disabled = false; }
    } }, 'Verify chain');

    return h('div', null,
        h('div', { class: 'page-head' },
            h('div', null, h('h1', null, 'Audit trail'),
                h('p', null, 'Every upload, status change, transmittal, review and file access on this project. Each entry is hashed together with the previous one, so a change anywhere breaks the chain.')),
            h('div', { class: 'actions' }, verify)),
        h('div', { style: 'margin-bottom:12px' }, result),
        h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ['#', 'Time', 'By', 'Event', 'Details', 'Hash'].map((x) => h('th', null, x)))),
            tbody)),
        h('div', { style: 'margin-top:12px' }, more));
}
