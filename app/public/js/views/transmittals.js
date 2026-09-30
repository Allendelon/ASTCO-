import {
    h, api, toast, field, select, fmtDate, fmtTime, fmtNumber,
    stateMark, codeMark, docNo, ltr, bidi, t, sep, enumOptions,
} from '../lib.js';
import { dataTable } from '../ui/table.js';
import { asyncRegion, emptyState } from '../ui/async.js';
import { actionButton, segmented } from '../ui/controls.js';

const RESPONSE_REASONS = ['FOR_APPROVAL', 'FOR_REVIEW'];
const REASONS = ['FOR_APPROVAL', 'FOR_REVIEW', 'FOR_INFORMATION', 'FOR_TENDER', 'FOR_CONSTRUCTION', 'AS_BUILT'];
const CODES = ['CODE_A', 'CODE_B', 'CODE_C', 'CODE_D'];
const tstatus = (s) => h('span', { class: `tstatus ${s}` }, t(`tstatus.${s}`));

export async function transmittalsView(ctx) {
    const { pid, meta } = ctx;
    const stored = (() => { try { return sessionStorage.getItem('cde.box'); } catch { return null; } })();
    const newButton = () => (meta.project.my_role !== 'VIEWER' ? h('button', { class: 'primary', onclick: () => ctx.go('transmittals/new') }, t('tr.new')) : null);

    const box = segmented({
        label: t('tr.title'),
        options: ['inbox', 'sent', 'all'].map((k) => [k, t(`tr.tab.${k}`)]),
        value: ['inbox', 'sent', 'all'].includes(stored) ? stored : 'inbox',
        onChange: (v) => { try { sessionStorage.setItem('cde.box', v); } catch { /* storage may be unavailable */ } list.reload(); },
    });
    const table = dataTable({
        caption: t('tr.title'),
        rowHref: (x) => `#/p/${pid}/transmittals/${x.id}`,
        rowClass: (x) => (x.overdue ? 'is-overdue' : ''),
        columns: [
            { id: 'number', header: t('tr.col.number'), cell: (x) => ltr(x.transmittal_number), primary: true },
            { id: 'subject', header: t('tr.col.subject'), cell: (x) => x.subject },
            { id: 'from', header: t('tr.col.from'), className: 'small', priority: 'low', cell: (x) => x.sender_name },
            { id: 'reason', header: t('tr.col.reason'), className: 'small', priority: 'low', cell: (x) => t(`reason.${x.reason_for_issue}`) },
            { id: 'status', header: t('tr.col.status'), cell: (x) => tstatus(x.status) },
            { id: 'due', header: t('tr.col.due'), numeric: true, className: 'small',
              cell: (x) => (!x.sla_due_date ? '–' : x.overdue
                  ? h('span', { class: 'overdue' }, t('tr.overdue', { date: fmtDate(x.sla_due_date) })) : fmtDate(x.sla_due_date)) },
            { id: 'documents', header: t('tr.col.documents'), className: 'small', priority: 'low',
              cell: (x) => t('tr.items', { n: fmtNumber(x.item_count), reviewed: fmtNumber(x.response_count) }) },
            { id: 'issued', header: t('tr.col.issued'), numeric: true, className: 'small muted', priority: 'low', cell: (x) => fmtDate(x.issued_at) },
        ],
    });
    const list = asyncRegion({
        load: (signal) => api('GET', `/projects/${pid}/transmittals?box=${box.value}`, undefined, { signal }),
        render: (rows) => table.setRows(rows).el,
        empty: () => emptyState({ title: t(box.value === 'inbox' ? 'tr.empty_inbox' : 'tr.empty'), action: newButton() }),
    });
    await list.reload();

    return h('div', null,
        h('div', { class: 'page-head' },
            h('div', null, h('h1', null, t('tr.title')),
                h('p', null, t('tr.intro'))),
            h('div', { class: 'actions' }, newButton())),
        h('div', { class: 'toolbar' }, box.el),
        list.el);
}

export async function newTransmittal(ctx, preselect) {
    const { pid, meta } = ctx;
    const docs = (await api('GET', `/projects/${pid}/documents`)).filter((d) => d.shared_revision_id);
    const myOrg = meta.project.my_org_id;
    const orgName = Object.fromEntries(meta.organizations.map((o) => [o.id, o.legal_name]));
    const others = meta.members.filter((m) => m.id !== ctx.me.user.id);
    const errorBox = h('div', { class: 'error-box hidden', role: 'alert' });
    const reason = select('reason_for_issue', enumOptions('reason', REASONS), 'FOR_APPROVAL', { required: true });
    const due = h('input', { type: 'date', name: 'sla_due_date', min: new Date().toISOString().slice(0, 10) });
    const dueHint = h('span', { class: 'hint' });
    const syncDue = () => {
        const needs = RESPONSE_REASONS.includes(reason.value);
        due.required = needs;
        dueHint.textContent = t(needs ? 'trn.due_required' : 'trn.optional');
    };
    reason.addEventListener('change', syncDue);
    syncDue();

    const docFilter = h('input', { type: 'search', placeholder: t('trn.filter_docs'), 'aria-label': t('trn.filter_docs') });
    const docList = h('div', { class: 'pick-list' }, docs.map((d) => h('label', { dataset: { text: `${d.document_number} ${d.title}`.toLowerCase() } },
        h('input', { type: 'checkbox', name: 'revision_ids', value: d.shared_revision_id, checked: d.shared_revision_id === preselect }),
        h('span', { style: 'flex:1' }, docNo(d.document_number), h('div', { class: 'small' }, d.title)),
        ltr(`${d.shared_revision_label} ${d.shared_suitability_code}`, 'mono small'))));
    docFilter.addEventListener('input', () => {
        const q = docFilter.value.toLowerCase();
        docList.querySelectorAll('label').forEach((l) => l.classList.toggle('hidden', !l.dataset.text.includes(q)));
    });

    const recipients = h('div', { class: 'pick-list' }, others
        .sort((a, b) => (a.organization_id === myOrg) - (b.organization_id === myOrg) || orgName[a.organization_id].localeCompare(orgName[b.organization_id]))
        .map((m) => h('div', { class: 'recip-row' },
            h('span', null, m.display_name, h('div', { class: 'small muted' }, orgName[m.organization_id])),
            select(`r:${m.id}`, [['', t('trn.not_included')], ['TO', t('trn.to')], ['CC', t('trn.cc')]], '', { 'aria-label': t('trn.include', { name: m.display_name }) }))));

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
        if (!body.revision_ids.length) { errorBox.textContent = t('trn.choose_doc'); errorBox.classList.remove('hidden'); return; }
        if (issue && !body.to.length) { errorBox.textContent = t('trn.need_to'); errorBox.classList.remove('hidden'); return; }
        form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try {
            const created = await api('POST', `/projects/${pid}/transmittals`, body);
            toast(t(issue ? 'trn.issued' : 'trn.saved', { number: created.transmittal_number }));
            ctx.go(`transmittals/${created.id}`);
        } catch (err) {
            errorBox.textContent = err.message;
            errorBox.classList.remove('hidden');
            form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        }
    } },
        h('div', { class: 'panel stack' },
            field(t('trn.subject'), h('input', { name: 'subject', required: true, maxlength: 255 })),
            h('div', { class: 'field-row' }, field(t('trn.reason'), reason), h('label', null, t('trn.due'), dueHint, due)),
            field(t('trn.message'), h('textarea', { name: 'message', dir: 'auto' }), t('trn.message_hint'))),
        h('div', { class: 'panel stack' }, h('h2', null, t('trn.recipients')),
            h('p', { class: 'muted small', style: 'margin:0' }, t('trn.recipients_note')),
            others.length ? recipients : h('p', { class: 'muted' }, t('trn.no_one'))),
        h('div', { class: 'panel stack' }, h('h2', null, t('trn.documents')),
            h('p', { class: 'muted small', style: 'margin:0' }, t('trn.documents_note')),
            docs.length ? [docFilter, docList] : h('p', { class: 'muted' }, t('trn.no_docs'))),
        errorBox,
        h('div', { class: 'actions' },
            h('button', { type: 'submit', value: 'draft' }, t('trn.save_draft')),
            h('button', { type: 'submit', value: 'issue', class: 'primary' }, t('trn.issue'))));

    return h('div', { style: 'max-width:860px' },
        h('p', { class: 'small', style: 'margin:0 0 8px' }, h('a', { href: `#/p/${pid}/transmittals` }, t('tr.title'))),
        h('div', { class: 'page-head' }, h('h1', null, t('trn.heading'))),
        form);
}

export async function transmittalView(ctx, id) {
    const { pid } = ctx;
    const d = await api('GET', `/transmittals/${id}`);
    const tr = d.transmittal;
    const answered = new Set(d.answered);
    const responsesFor = (rid) => d.responses.filter((r) => r.revision_id === rid);

    const act = (label, variant, onClick, body, danger = false) => actionButton({
        label, variant, onClick, onDone: ctx.refresh,
        confirm: { title: label, body, confirmLabel: label, danger },
    });

    const reviewRows = d.can.respond ? d.items.filter((i) => !answered.has(i.revision_id)) : [];
    const reviewForm = reviewRows.length ? h('form', { class: 'panel stack', onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const responses = reviewRows.map((i) => ({
            revision_id: i.revision_id, review_code: fd.get(`code:${i.revision_id}`), comments: fd.get(`comments:${i.revision_id}`),
        })).filter((r) => r.review_code);
        if (!responses.length) { toast(t('trv.choose_code_one'), 'error'); return; }
        const missing = responses.find((r) => ['CODE_C', 'CODE_D'].includes(r.review_code) && !r.comments.trim());
        if (missing) {
            toast(t('trv.cd_comment'), 'error');
            e.target.querySelector(`textarea[name="comments:${missing.revision_id}"]`)?.focus();
            return;
        }
        const submit = e.target.querySelector('button[type=submit]');
        if (submit.getAttribute('aria-disabled') === 'true') return;
        submit.setAttribute('aria-disabled', 'true');
        try {
            await api('POST', `/transmittals/${id}/responses`, { responses });
            toast(t('trv.submitted'));
            ctx.refresh();
        } catch (err) { toast(err.message, 'error'); } finally { submit.removeAttribute('aria-disabled'); }
    } },
        h('h2', null, t('trv.your_review')),
        h('p', { class: 'muted small', style: 'margin:0' }, t('trv.review_note')),
        reviewRows.map((i) => h('div', { class: 'field-row', style: 'grid-template-columns: 1fr 220px; align-items:start' },
            h('div', null, docNo(i.document_number), ' ', ltr(i.revision_label), h('div', { class: 'small' }, i.title),
                h('textarea', { name: `comments:${i.revision_id}`, dir: 'auto', placeholder: t('trv.comments'), style: 'margin-top:6px;min-height:60px', 'aria-label': t('trv.comments_on', { number: i.document_number }) })),
            select(`code:${i.revision_id}`, [['', t('trv.choose_code')], ...enumOptions('code', CODES)], '', { 'aria-label': t('trv.code_for', { number: i.document_number }) }))),
        h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, t('trv.submit')))) : null;

    return h('div', null,
        h('p', { class: 'small', style: 'margin:0 0 8px' }, h('a', { href: `#/p/${pid}/transmittals` }, t('tr.title'))),
        h('div', { class: 'page-head' },
            h('div', null,
                h('div', { class: 'muted' }, ltr(tr.transmittal_number)),
                h('h1', null, tr.subject)),
            h('div', { class: 'actions' },
                d.can.issue ? act(t('trn.issue'), 'primary', () => api('POST', `/transmittals/${id}/issue`), t('trv.confirm_issue')) : null,
                d.can.edit ? actionButton({ label: t('trv.delete_draft'), variant: 'danger', onClick: () => api('DELETE', `/transmittals/${id}`), onDone: () => ctx.go('transmittals'),
                    confirm: { title: t('trv.delete_draft'), body: t('trv.confirm_delete'), confirmLabel: t('trv.delete_draft'), danger: true } }) : null,
                d.can.close ? act(t('trv.close'), '', () => api('POST', `/transmittals/${id}/close`), t('trv.confirm_close')) : null)),
        h('div', { class: 'doc-grid', style: 'grid-template-columns: minmax(280px, 360px) 1fr' },
            h('div', null,
                h('div', { class: 'panel' },
                    h('dl', { class: 'facts' },
                        h('dt', null, t('trv.status')), h('dd', null, tstatus(tr.status)),
                        h('dt', null, t('trv.from')), h('dd', null, tr.sender_name, h('div', { class: 'small muted' }, tr.created_by_name)),
                        h('dt', null, t('trv.reason')), h('dd', null, t(`reason.${tr.reason_for_issue}`)),
                        h('dt', null, t('trv.due')), h('dd', null, tr.sla_due_date ? fmtDate(tr.sla_due_date) : '–'),
                        h('dt', null, t('trv.issued')), h('dd', null, tr.issued_at ? fmtTime(tr.issued_at) : t('trv.not_issued')))),
                h('div', { class: 'panel' }, h('h2', null, t('trv.recipients')),
                    d.recipients.length
                        ? h('dl', { class: 'facts' }, d.recipients.flatMap((r) => [
                            h('dt', null, t(r.kind === 'TO' ? 'trn.to' : 'trn.cc')),
                            h('dd', null, r.display_name, h('div', { class: 'small muted' }, r.organization))]))
                        : h('p', { class: 'muted', style: 'margin:0' }, t('trv.no_recipients'))),
                tr.message ? h('div', { class: 'panel' }, h('h2', null, t('trv.message')), h('p', { dir: 'auto', style: 'margin:0;white-space:pre-wrap' }, tr.message)) : null),
            h('div', null,
                h('div', { class: 'table-wrap' }, h('table', null,
                    h('thead', null, h('tr', null, ['document', 'revision', 'state', 'review'].map((x) => h('th', null, t(`trv.col.${x}`))))),
                    h('tbody', null, d.items.map((i) => h('tr', null,
                        h('td', null, h('a', { href: `#/p/${pid}/documents/${i.document_id}` }, docNo(i.document_number)), h('div', { class: 'small' }, i.title)),
                        h('td', null, ltr(`${i.revision_label} ${i.suitability_code}`)),
                        h('td', null, stateMark(i.cde_state)),
                        h('td', null, responsesFor(i.revision_id).length
                            ? responsesFor(i.revision_id).map((r) => h('div', { style: 'margin-bottom:6px' },
                                codeMark(r.review_code), ' ', h('span', { class: 'small' }, bidi(r.organization), sep(), fmtDate(r.responded_at)),
                                r.comments ? h('div', { class: 'small', dir: 'auto', style: 'white-space:pre-wrap' }, r.comments) : null))
                            : h('span', { class: 'muted small' }, RESPONSE_REASONS.includes(tr.reason_for_issue) && tr.status !== 'DRAFT' ? t('trv.awaiting') : '–'))))))),
                reviewForm ? h('div', { style: 'margin-top:16px' }, reviewForm) : null)));
}
