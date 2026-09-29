import {
    h, render, api, toast, field, select, fmtDate, fmtTime,
    stateMark, codeMark, docNo, TSTATUS_LABEL, REASON_LABEL, CODE_LABEL,
} from '../lib.js';

const RESPONSE_REASONS = ['FOR_APPROVAL', 'FOR_REVIEW'];

export async function transmittalsView(ctx) {
    const { pid, meta } = ctx;
    let box = sessionStorage.getItem('cde.box') || 'inbox';
    const wrap = h('div', { class: 'table-wrap' });
    const tabs = h('div', { class: 'segmented', role: 'tablist' });

    async function load() {
        try { sessionStorage.setItem('cde.box', box); } catch { /* storage may be unavailable */ }
        render(tabs, [['inbox', 'Inbox'], ['sent', 'Sent'], ['all', 'All']].map(([k, label]) =>
            h('a', { href: '#', role: 'tab', 'aria-current': k === box ? 'page' : null, 'aria-selected': String(k === box),
                onclick: (e) => { e.preventDefault(); box = k; load(); } }, label)));
        const rows = await api('GET', `/projects/${pid}/transmittals?box=${box}`);
        if (!rows.length) {
            render(wrap, h('div', { class: 'empty' },
                h('p', null, box === 'inbox' ? 'Nothing has been sent to your organisation yet.' : 'No transmittals here yet.'),
                meta.project.my_role !== 'VIEWER' ? h('button', { class: 'primary', onclick: () => ctx.go('transmittals/new') }, 'New transmittal') : null));
            return;
        }
        render(wrap, h('table', null,
            h('thead', null, h('tr', null, ['Number', 'Subject', 'From', 'Reason', 'Status', 'Response due', 'Documents', 'Issued'].map((t) => h('th', null, t)))),
            h('tbody', null, rows.map((t) => h('tr', {
                class: 'clickable', tabindex: 0,
                onclick: () => ctx.go(`transmittals/${t.id}`),
                onkeydown: (e) => { if (e.key === 'Enter') ctx.go(`transmittals/${t.id}`); },
            },
                h('td', { class: 'mono num' }, t.transmittal_number),
                h('td', null, t.subject),
                h('td', { class: 'small' }, t.sender_name),
                h('td', { class: 'small' }, REASON_LABEL[t.reason_for_issue]),
                h('td', null, h('span', { class: `tstatus ${t.status}` }, TSTATUS_LABEL[t.status])),
                h('td', { class: `num small ${t.overdue ? 'overdue' : ''}` }, t.sla_due_date ? `${fmtDate(t.sla_due_date)}${t.overdue ? ', overdue' : ''}` : '–'),
                h('td', { class: 'small' }, `${t.item_count} (${t.response_count} reviewed)`),
                h('td', { class: 'small muted num' }, fmtDate(t.issued_at)))))));
    }
    await load();

    return h('div', null,
        h('div', { class: 'page-head' },
            h('div', null, h('h1', null, 'Transmittals'),
                h('p', null, 'Formal issue of documents between organisations. Once issued, a transmittal and its documents cannot be changed.')),
            h('div', { class: 'actions' },
                meta.project.my_role !== 'VIEWER' ? h('button', { class: 'primary', onclick: () => ctx.go('transmittals/new') }, 'New transmittal') : null)),
        h('div', { class: 'toolbar' }, tabs),
        wrap);
}

export async function newTransmittal(ctx, preselect) {
    const { pid, meta } = ctx;
    const docs = (await api('GET', `/projects/${pid}/documents`)).filter((d) => d.shared_revision_id);
    const myOrg = meta.project.my_org_id;
    const orgName = Object.fromEntries(meta.organizations.map((o) => [o.id, o.legal_name]));
    const others = meta.members.filter((m) => m.id !== ctx.me.user.id);
    const errorBox = h('div', { class: 'error-box hidden', role: 'alert' });
    const reason = select('reason_for_issue', Object.entries(REASON_LABEL), 'FOR_APPROVAL', { required: true });
    const due = h('input', { type: 'date', name: 'sla_due_date', min: new Date().toISOString().slice(0, 10) });
    const dueHint = h('span', { class: 'hint' });
    const syncDue = () => {
        const needs = RESPONSE_REASONS.includes(reason.value);
        due.required = needs;
        dueHint.textContent = needs ? 'Required: recipients must respond by this date.' : 'Optional.';
    };
    reason.addEventListener('change', syncDue);
    syncDue();

    const docFilter = h('input', { type: 'search', placeholder: 'Filter documents', 'aria-label': 'Filter documents' });
    const docList = h('div', { class: 'pick-list' }, docs.map((d) => h('label', { dataset: { text: `${d.document_number} ${d.title}`.toLowerCase() } },
        h('input', { type: 'checkbox', name: 'revision_ids', value: d.shared_revision_id, checked: d.shared_revision_id === preselect }),
        h('span', { style: 'flex:1' }, docNo(d.document_number), h('div', { class: 'small' }, d.title)),
        h('span', { class: 'mono small' }, `${d.shared_revision_label} ${d.shared_suitability_code}`))));
    docFilter.addEventListener('input', () => {
        const q = docFilter.value.toLowerCase();
        docList.querySelectorAll('label').forEach((l) => l.classList.toggle('hidden', !l.dataset.text.includes(q)));
    });

    const recipients = h('div', { class: 'pick-list' }, others
        .sort((a, b) => (a.organization_id === myOrg) - (b.organization_id === myOrg) || orgName[a.organization_id].localeCompare(orgName[b.organization_id]))
        .map((m) => h('div', { class: 'recip-row' },
            h('span', null, m.display_name, h('div', { class: 'small muted' }, orgName[m.organization_id])),
            select(`r:${m.id}`, [['', 'Not included'], ['TO', 'To'], ['CC', 'Cc']], '', { 'aria-label': `Include ${m.display_name}` }))));

    const form = h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const issue = e.submitter?.value === 'issue';
        const body = {
            subject: fd.get('subject'), message: fd.get('message'), reason_for_issue: fd.get('reason_for_issue'),
            sla_due_date: fd.get('sla_due_date') || null, revision_ids: fd.getAll('revision_ids'), to: [], cc: [], issue,
        };
        for (const [k, v] of fd.entries()) {
            if (k.startsWith('r:') && v) body[v === 'TO' ? 'to' : 'cc'].push(k.slice(2));
        }
        errorBox.classList.add('hidden');
        if (!body.revision_ids.length) { errorBox.textContent = 'Choose at least one document.'; errorBox.classList.remove('hidden'); return; }
        if (issue && !body.to.length) { errorBox.textContent = 'Add at least one "To" recipient before issuing.'; errorBox.classList.remove('hidden'); return; }
        form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
            const t = await api('POST', `/projects/${pid}/transmittals`, body);
            toast(issue ? `Issued ${t.transmittal_number}` : `Saved draft ${t.transmittal_number}`);
            ctx.go(`transmittals/${t.id}`);
        } catch (err) {
            errorBox.textContent = err.message;
            errorBox.classList.remove('hidden');
            form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        }
    } },
        h('div', { class: 'panel stack' },
            field('Subject', h('input', { name: 'subject', required: true, maxlength: 255 })),
            h('div', { class: 'field-row' }, field('Reason for issue', reason), h('label', null, 'Response due', dueHint, due)),
            field('Message', h('textarea', { name: 'message' }), 'Optional covering note.')),
        h('div', { class: 'panel stack' }, h('h2', null, 'Recipients'),
            h('p', { class: 'muted small', style: 'margin:0' }, '"To" recipients review and stamp the documents. "Cc" recipients can read them.'),
            others.length ? recipients : h('p', { class: 'muted' }, 'No one else is on this project yet.')),
        h('div', { class: 'panel stack' }, h('h2', null, 'Documents'),
            h('p', { class: 'muted small', style: 'margin:0' }, 'Only shared or published revisions can be transmitted. Work in progress stays in your team.'),
            docs.length ? [docFilter, docList] : h('p', { class: 'muted' }, 'No shared documents yet. Share a revision (S1–S4) from the document register first.')),
        errorBox,
        h('div', { class: 'actions' },
            h('button', { type: 'submit', value: 'draft' }, 'Save draft'),
            h('button', { type: 'submit', value: 'issue', class: 'primary' }, 'Issue transmittal')));

    return h('div', { style: 'max-width:860px' },
        h('p', { class: 'small', style: 'margin:0 0 8px' }, h('a', { href: `#/p/${pid}/transmittals` }, 'Transmittals')),
        h('div', { class: 'page-head' }, h('h1', null, 'New transmittal')),
        form);
}

export async function transmittalView(ctx, id) {
    const { pid } = ctx;
    const d = await api('GET', `/transmittals/${id}`);
    const t = d.transmittal;
    const answered = new Set(d.answered);
    const responsesFor = (rid) => d.responses.filter((r) => r.revision_id === rid);

    const act = (label, cls, fn, confirmText) => h('button', { class: cls, onclick: async () => {
        if (confirmText && !confirm(confirmText)) return;
        try { await fn(); ctx.refresh(); } catch (err) { toast(err.message, 'error'); }
    } }, label);

    const reviewRows = d.can.respond ? d.items.filter((i) => !answered.has(i.revision_id)) : [];
    const reviewForm = reviewRows.length ? h('form', { class: 'panel stack', onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const responses = reviewRows.map((i) => ({
            revision_id: i.revision_id, review_code: fd.get(`code:${i.revision_id}`), comments: fd.get(`comments:${i.revision_id}`),
        })).filter((r) => r.review_code);
        if (!responses.length) { toast('Choose a review code for at least one document.', 'error'); return; }
        const missing = responses.find((r) => ['CODE_C', 'CODE_D'].includes(r.review_code) && !r.comments.trim());
        if (missing) {
            toast('Codes C and D return the document, so add a comment saying what must change.', 'error');
            e.target.querySelector(`textarea[name="comments:${missing.revision_id}"]`)?.focus();
            return;
        }
        try {
            await api('POST', `/transmittals/${id}/responses`, { responses });
            toast('Review submitted');
            ctx.refresh();
        } catch (err) { toast(err.message, 'error'); }
    } },
        h('h2', null, 'Your review'),
        h('p', { class: 'muted small', style: 'margin:0' }, 'Codes C and D return the document, so they need a comment. Submitted reviews cannot be changed.'),
        reviewRows.map((i) => h('div', { class: 'field-row', style: 'grid-template-columns: 1fr 220px; align-items:start' },
            h('div', null, docNo(i.document_number), ' ', h('span', { class: 'mono' }, i.revision_label), h('div', { class: 'small' }, i.title),
                h('textarea', { name: `comments:${i.revision_id}`, placeholder: 'Comments', style: 'margin-top:6px;min-height:60px', 'aria-label': `Comments on ${i.document_number}` })),
            select(`code:${i.revision_id}`, [['', 'Choose a code'], ...Object.entries(CODE_LABEL)], '', { 'aria-label': `Review code for ${i.document_number}` }))),
        h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Submit review'))) : null;

    return h('div', null,
        h('p', { class: 'small', style: 'margin:0 0 8px' }, h('a', { href: `#/p/${pid}/transmittals` }, 'Transmittals')),
        h('div', { class: 'page-head' },
            h('div', null,
                h('div', { class: 'mono muted' }, t.transmittal_number),
                h('h1', null, t.subject)),
            h('div', { class: 'actions' },
                d.can.issue ? act('Issue transmittal', 'primary', () => api('POST', `/transmittals/${id}/issue`), 'Issue this transmittal? After issue it cannot be edited or withdrawn.') : null,
                d.can.edit ? act('Delete draft', 'danger', async () => { await api('DELETE', `/transmittals/${id}`); ctx.go('transmittals'); }, 'Delete this draft?') : null,
                d.can.close ? act('Close transmittal', '', () => api('POST', `/transmittals/${id}/close`), 'Close this transmittal? Recipients will no longer be able to respond.') : null)),
        h('div', { class: 'doc-grid', style: 'grid-template-columns: minmax(280px, 360px) 1fr' },
            h('div', null,
                h('div', { class: 'panel' },
                    h('dl', { class: 'facts' },
                        h('dt', null, 'Status'), h('dd', null, h('span', { class: `tstatus ${t.status}` }, TSTATUS_LABEL[t.status])),
                        h('dt', null, 'From'), h('dd', null, t.sender_name, h('div', { class: 'small muted' }, t.created_by_name)),
                        h('dt', null, 'Reason'), h('dd', null, REASON_LABEL[t.reason_for_issue]),
                        h('dt', null, 'Response due'), h('dd', null, t.sla_due_date ? fmtDate(t.sla_due_date) : '–'),
                        h('dt', null, 'Issued'), h('dd', null, t.issued_at ? fmtTime(t.issued_at) : 'Not yet issued'))),
                h('div', { class: 'panel' }, h('h2', null, 'Recipients'),
                    d.recipients.length
                        ? h('dl', { class: 'facts' }, d.recipients.flatMap((r) => [
                            h('dt', null, r.kind === 'TO' ? 'To' : 'Cc'),
                            h('dd', null, r.display_name, h('div', { class: 'small muted' }, r.organization))]))
                        : h('p', { class: 'muted', style: 'margin:0' }, 'No recipients yet.')),
                t.message ? h('div', { class: 'panel' }, h('h2', null, 'Message'), h('p', { style: 'margin:0;white-space:pre-wrap' }, t.message)) : null),
            h('div', null,
                h('div', { class: 'table-wrap' }, h('table', null,
                    h('thead', null, h('tr', null, ['Document', 'Revision', 'State', 'Review'].map((x) => h('th', null, x)))),
                    h('tbody', null, d.items.map((i) => h('tr', null,
                        h('td', null, h('a', { href: `#/p/${pid}/documents/${i.document_id}` }, docNo(i.document_number)), h('div', { class: 'small' }, i.title)),
                        h('td', { class: 'mono' }, `${i.revision_label} ${i.suitability_code}`),
                        h('td', null, stateMark(i.cde_state)),
                        h('td', null, responsesFor(i.revision_id).length
                            ? responsesFor(i.revision_id).map((r) => h('div', { style: 'margin-bottom:6px' },
                                codeMark(r.review_code), ' ', h('span', { class: 'small' }, `${r.organization}, ${fmtDate(r.responded_at)}`),
                                r.comments ? h('div', { class: 'small', style: 'white-space:pre-wrap' }, r.comments) : null))
                            : h('span', { class: 'muted small' }, RESPONSE_REASONS.includes(t.reason_for_issue) && t.status !== 'DRAFT' ? 'Awaiting review' : '–'))))))),
                reviewForm ? h('div', { style: 'margin-top:16px' }, reviewForm) : null)));
}
