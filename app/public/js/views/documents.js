import {
    h, render, api, toast, dialog, field, select, fmtDate, fmtTime, fmtBytes,
    stateMark, codeMark, docNo, STATE_LABEL, TSTATUS_LABEL,
} from '../lib.js';

const FIELDS = [['volume_code', 'VOLUME', 'Volume'], ['level_code', 'LEVEL', 'Level'], ['type_code', 'TYPE', 'Type'], ['role_code', 'ROLE', 'Role']];

const canWrite = (meta) => meta.project.my_role !== 'VIEWER';
const suitabilityText = (meta, code) => meta.suitability.find((s) => s.code === code)?.description || code;

export async function documentsView(ctx) {
    const { pid, meta } = ctx;
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const tbody = h('tbody');
    const wrap = h('div', { class: 'table-wrap' });
    const search = h('input', { type: 'search', placeholder: 'Search number or title', 'aria-label': 'Search documents', value: params.get('q') || '' });
    const stateFilter = select('state', [['', 'Any state'], ['WIP', STATE_LABEL.WIP], ['SHARED', STATE_LABEL.SHARED], ['PUBLISHED', STATE_LABEL.PUBLISHED], ['NONE', 'No revision yet']], params.get('state') || '', { 'aria-label': 'Filter by state' });
    const summary = h('p', { class: 'muted small', style: 'margin:10px 2px 0' });

    let controller;
    async function load() {
        controller?.abort();
        controller = new AbortController();
        const qs = new URLSearchParams({ q: search.value.trim(), state: stateFilter.value });
        let rows;
        try {
            rows = await api('GET', `/projects/${pid}/documents?${qs}`, undefined, { signal: controller.signal });
        } catch (err) {
            if (err.name !== 'AbortError') toast(err.message, 'error');
            return;
        }
        if (!rows.length) {
            const filtered = search.value || stateFilter.value;
            render(wrap, h('div', { class: 'empty' },
                h('p', null, filtered ? 'No documents match these filters.' : 'No documents are registered on this project yet.'),
                !filtered && canWrite(meta) ? h('button', { class: 'primary', onclick: () => registerDialog(ctx) }, 'Register a document') : null));
            summary.textContent = '';
            return;
        }
        render(tbody, rows.map((d) => h('tr', {
            class: 'clickable', tabindex: 0,
            onclick: () => ctx.go(`documents/${d.id}`),
            onkeydown: (e) => { if (e.key === 'Enter') ctx.go(`documents/${d.id}`); },
        },
            h('td', { class: 'num' }, docNo(d.document_number)),
            h('td', null, d.title),
            h('td', { class: 'mono' }, d.revision_label || '–'),
            h('td', { title: d.suitability_code ? suitabilityText(meta, d.suitability_code) : null }, d.suitability_code ? h('span', { class: 'mono' }, d.suitability_code) : ''),
            h('td', null, stateMark(d.cde_state)),
            h('td', { class: 'muted small num' }, fmtDate(d.revised_at || d.created_at)))));
        render(wrap, h('table', null,
            h('thead', null, h('tr', null, ['Document number', 'Title', 'Revision', 'Status', 'State', 'Updated'].map((t) => h('th', null, t)))),
            tbody));
        summary.textContent = rows.length === 1000 ? 'Showing the first 1,000 documents. Narrow the search to see others.' : `${rows.length} document${rows.length === 1 ? '' : 's'}`;
    }

    let t;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 200); });
    stateFilter.addEventListener('change', load);
    await load();

    return h('div', null,
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', null, 'Document register'),
                h('p', null, 'Work in progress is visible to your organisation only. Shared and published revisions are visible to everyone on the project.')),
            h('div', { class: 'actions' },
                canWrite(meta) ? h('button', { class: 'primary', onclick: () => registerDialog(ctx) }, 'Register document') : null)),
        h('div', { class: 'toolbar' }, search, stateFilter),
        wrap, summary);
}

function registerDialog(ctx) {
    const { meta, pid } = ctx;
    const myCode = meta.organizations.find((o) => o.id === meta.project.my_org_id)?.originator_code;
    const preview = h('div', { class: 'titleblock', style: 'margin:0' });
    let form;
    const update = () => {
        const fd = new FormData(form);
        const vals = [meta.project.code, myCode, ...FIELDS.map(([n]) => fd.get(n)), fd.get('number_code') || 'next'];
        const names = ['Project', 'Originator', 'Volume', 'Level', 'Type', 'Role', 'Number'];
        render(preview, vals.map((v, i) => h('div', null, h('b', null, v), h('small', null, names[i]))));
    };
    dialog({
        title: 'Register document',
        submitLabel: 'Register document',
        wide: true,
        build: (body) => {
            form = body.closest('form');
            body.append(
                h('p', { class: 'muted', style: 'margin:0' }, 'The document number follows ISO 19650 and cannot be changed after registration. The title can.'),
                preview,
                h('div', { class: 'field-row' }, FIELDS.map(([name, f, label]) => field(label,
                    select(name, meta.codes.filter((c) => c.field === f).map((c) => [c.code, `${c.code} – ${c.description}`]), undefined, { required: true, onchange: update })))),
                h('div', { class: 'field-row' },
                    field('Number', h('input', { name: 'number_code', inputmode: 'numeric', pattern: '[0-9]{4,6}', placeholder: 'Next free', oninput: update }), '4–6 digits. Leave blank for the next free number.')),
                field('Title', h('input', { name: 'title', required: true, maxlength: 255 })));
            update();
        },
        onSubmit: async (fd) => {
            const body = Object.fromEntries(fd.entries());
            if (!body.number_code) delete body.number_code;
            const doc = await api('POST', `/projects/${pid}/documents`, body);
            toast(`Registered ${doc.document_number}`);
            ctx.go(`documents/${doc.id}`);
        },
    });
}

export async function documentView(ctx, id) {
    const { meta } = ctx;
    const { document: doc, revisions, transmittals } = await api('GET', `/documents/${id}`);
    const latest = revisions[0];
    const isDC = ['ADMIN', 'DOC_CONTROLLER'].includes(doc.my_role);
    const mayUpload = doc.is_mine && doc.my_role !== 'VIEWER';
    const previewPane = h('div');
    let selected = latest?.id;

    const segs = [[doc.project_code, 'Project'], [doc.originator_code, 'Originator'], [doc.volume_code, 'Volume'], [doc.level_code, 'Level'], [doc.type_code, 'Type'], [doc.role_code, 'Role'], [doc.number_code, 'Number']];
    const titleblock = h('div', { class: 'titleblock', role: 'img', 'aria-label': `Document number ${doc.document_number}${latest ? `, revision ${latest.revision_label}` : ''}` },
        segs.map(([v, l]) => h('div', null, h('b', null, v), h('small', null, l))),
        h('div', { class: 'rev' }, h('b', null, latest?.revision_label || '—'), h('small', null, latest ? suitabilityText(meta, latest.suitability_code) : 'No revision yet')));

    function showPreview(rev) {
        selected = rev?.id;
        timeline.querySelectorAll('li').forEach((li) => li.setAttribute('aria-selected', String(li.dataset.id === selected)));
        if (!rev) return render(previewPane, h('div', { class: 'preview-empty' }, mayUpload ? 'Upload the first revision to see it here.' : 'No revisions yet.'));
        const src = `/api/revisions/${rev.id}/file?inline=1`;
        if (rev.mime_type === 'application/pdf') render(previewPane, h('iframe', { class: 'preview', src, title: `Preview of ${rev.revision_label}` }));
        else if (/^image\/(png|jpeg|webp|gif)$/.test(rev.mime_type)) render(previewPane, h('img', { src, alt: `${doc.document_number} revision ${rev.revision_label}`, style: 'max-width:100%;border:1px solid var(--line);border-radius:6px;background:#fff' }));
        else render(previewPane, h('div', { class: 'preview-empty' }, h('div', null, h('p', null, `${rev.original_filename} can't be previewed in the browser.`), h('a', { class: 'button', href: `/api/revisions/${rev.id}/file` }, 'Download file'))));
    }

    const timeline = h('ul', { class: 'timeline' }, revisions.map((r) => {
        const suitOptions = meta.suitability.filter((s) =>
            s.revision_prefix === (r.revision_label.startsWith('C') ? 'C' : 'P')
            && ['WIP', 'SHARED', 'PUBLISHED'].indexOf(s.cde_state) >= ['WIP', 'SHARED', 'PUBLISHED'].indexOf(r.cde_state)
            && !(r.revision_label.includes('.') && s.cde_state !== 'WIP'));
        const changeStatus = doc.is_mine && isDC && suitOptions.length > 1
            ? select('suitability', suitOptions.map((s) => [s.code, `${s.code} – ${s.description}`]), r.suitability_code, {
                'aria-label': `Change status of ${r.revision_label}`,
                onclick: (e) => e.stopPropagation(),
                onchange: async (e) => {
                    try {
                        await api('PATCH', `/revisions/${r.id}`, { suitability_code: e.target.value });
                        toast(`${r.revision_label} is now ${e.target.value}`);
                        ctx.refresh();
                    } catch (err) { toast(err.message, 'error'); e.target.value = r.suitability_code; }
                },
            })
            : null;
        const transmitted = transmittals.filter((t) => t.revision_id === r.id);
        return h('li', { class: r.cde_state, dataset: { id: r.id }, tabindex: 0, onclick: () => showPreview(r), onkeydown: (e) => { if (e.key === 'Enter') showPreview(r); } },
            h('div', { class: 'rev-line' },
                h('span', { class: 'rev-label' }, r.revision_label),
                stateMark(r.cde_state),
                h('span', { class: 'mono', title: r.suitability_description }, r.suitability_code),
                transmitted.flatMap((t) => (t.review_codes ? t.review_codes.split(', ').map(codeMark) : []))),
            h('div', { class: 'meta' }, `${r.uploaded_by_name || 'Unknown'}, ${fmtTime(r.created_at)}`),
            h('div', { class: 'meta' }, `${r.original_filename}, ${fmtBytes(r.size_bytes)}`),
            h('div', { class: 'hash', title: 'SHA-256 of the stored file' }, r.sha256),
            h('div', { class: 'rev-actions' },
                h('a', { href: `/api/revisions/${r.id}/file`, onclick: (e) => e.stopPropagation() }, 'Download'),
                changeStatus,
                doc.is_mine && r.cde_state !== 'WIP' && doc.my_role !== 'VIEWER'
                    ? h('a', { href: `#/p/${ctx.pid}/transmittals/new/${r.id}`, onclick: (e) => e.stopPropagation() }, 'Transmit')
                    : null,
                doc.is_mine && r.cde_state === 'WIP' && doc.my_role !== 'VIEWER'
                    ? h('button', { class: 'link danger', onclick: async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Delete work-in-progress revision ${r.revision_label}? Shared revisions are kept permanently, but WIP can be removed.`)) return;
                        try { await api('DELETE', `/revisions/${r.id}`); toast(`Deleted ${r.revision_label}`); ctx.refresh(); } catch (err) { toast(err.message, 'error'); }
                    } }, 'Delete')
                    : null));
    }));

    const history = transmittals.length
        ? h('div', { class: 'panel' }, h('h2', null, 'Transmittals'),
            h('ul', { style: 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px' }, transmittals.map((t) => {
                const rev = revisions.find((r) => r.id === t.revision_id);
                return h('li', null,
                    h('a', { href: `#/p/${ctx.pid}/transmittals/${t.id}`, class: 'mono' }, t.transmittal_number),
                    ' ', h('span', { class: `tstatus ${t.status}` }, TSTATUS_LABEL[t.status]),
                    h('div', { class: 'small muted' }, `${rev?.revision_label || ''} – ${t.subject}`));
            })))
        : null;

    const titleText = h('h1', null, doc.title);
    const page = h('div', null,
        h('p', { class: 'small', style: 'margin:0 0 8px' }, h('a', { href: `#/p/${ctx.pid}/documents` }, 'Document register')),
        h('div', { class: 'page-head', style: 'margin-bottom:4px' },
            h('div', null, titleText, h('p', null, `Originated by ${doc.originator_name}`)),
            h('div', { class: 'actions' },
                doc.is_mine && doc.my_role !== 'VIEWER' ? h('button', { onclick: () => renameDialog(ctx, doc) }, 'Edit title') : null,
                mayUpload ? h('button', { class: 'primary', onclick: () => uploadDialog(ctx, doc, latest) }, 'Upload revision') : null)),
        titleblock,
        h('div', { class: 'doc-grid' },
            h('div', null,
                h('div', { class: 'panel' }, h('h2', null, 'Revisions'),
                    revisions.length ? timeline : h('p', { class: 'muted', style: 'margin:0' }, 'No revisions yet.')),
                history),
            previewPane));
    showPreview(latest);
    return page;
}

function renameDialog(ctx, doc) {
    dialog({
        title: 'Edit title',
        submitLabel: 'Save title',
        build: (body) => body.append(field('Title', h('input', { name: 'title', required: true, maxlength: 255, value: doc.title }))),
        onSubmit: async (fd) => {
            await api('PATCH', `/documents/${doc.id}`, { title: fd.get('title') });
            toast('Title saved');
            ctx.refresh();
        },
    });
}

function uploadDialog(ctx, doc, latest) {
    const { meta } = ctx;
    const afterC = latest?.revision_label.startsWith('C');
    const groups = ['WIP', 'SHARED', 'PUBLISHED'].map((st) => h('optgroup', { label: STATE_LABEL[st] },
        meta.suitability.filter((s) => s.cde_state === st && (!afterC || s.revision_prefix === 'C'))
            .map((s) => h('option', { value: s.code }, `${s.code} – ${s.description}`))));
    const suit = h('select', { name: 'suitability_code', required: true }, groups.filter((g) => g.children.length));
    const status = h('p', { class: 'muted small', style: 'margin:0' });
    dialog({
        title: `Upload revision – ${doc.document_number}`,
        submitLabel: 'Upload revision',
        build: (body) => body.append(
            field('File', h('input', { name: 'file', type: 'file', required: true })),
            field('Status', suit, afterC
                ? 'This document is published under a C revision, so only C codes are allowed.'
                : 'S0 keeps it in your team as work in progress. S1–S4 share it with the project.'),
            status),
        onSubmit: async (fd) => {
            const file = fd.get('file');
            if (!file || !file.size) throw new Error('Choose a file to upload.');
            status.textContent = `Uploading ${file.name} (${fmtBytes(file.size)})…`;
            const up = await api('PUT', `/projects/${ctx.pid}/uploads`, file);
            status.textContent = 'Registering revision…';
            const rev = await api('POST', `/documents/${doc.id}/revisions`, {
                object_key: up.object_key, suitability_code: fd.get('suitability_code'),
                original_filename: file.name, mime_type: file.type || 'application/octet-stream',
            });
            toast(`Uploaded ${rev.revision_label}`);
            ctx.refresh();
        },
    });
}
