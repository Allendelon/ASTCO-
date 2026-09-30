import {
    h, render, api, toast, dialog, field, select, fmtDate, fmtTime, fmtBytes,
    stateMark, codeMark, docNo, ltr, bidi, desc, t, tn, sep,
} from '../lib.js';

const FIELDS = [['volume_code', 'VOLUME', 'tb.volume'], ['level_code', 'LEVEL', 'tb.level'], ['type_code', 'TYPE', 'tb.type'], ['role_code', 'ROLE', 'tb.role']];
const TITLEBLOCK_LABELS = ['tb.project', 'tb.originator', 'tb.volume', 'tb.level', 'tb.type', 'tb.role', 'tb.number'];

const canWrite = (meta) => meta.project.my_role !== 'VIEWER';
// Code-list and suitability descriptions come from the project's own set-up
// data, so they appear as the project administrator entered them.
const suitabilityText = (meta, code) => { const s = meta.suitability.find((x) => x.code === code); return s ? desc(s) : code; };

export async function documentsView(ctx) {
    const { pid, meta } = ctx;
    const tbody = h('tbody');
    const wrap = h('div', { class: 'table-wrap' });
    const search = h('input', { type: 'search', placeholder: t('docs.search_placeholder'), 'aria-label': t('docs.search_label') });
    const stateFilter = select('state', [['', t('docs.any_state')], ['WIP', t('state.WIP')], ['SHARED', t('state.SHARED')],
        ['PUBLISHED', t('state.PUBLISHED')], ['NONE', t('docs.no_revision_yet')]], '', { 'aria-label': t('docs.filter_label') });
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
                h('p', null, filtered ? t('docs.empty_filtered') : t('docs.empty')),
                !filtered && canWrite(meta) ? h('button', { class: 'primary', onclick: () => registerDialog(ctx) }, t('docs.register_first')) : null));
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
            h('td', null, ltr(d.revision_label || '–')),
            h('td', { title: d.suitability_code ? suitabilityText(meta, d.suitability_code) : null }, d.suitability_code ? ltr(d.suitability_code) : ''),
            h('td', null, stateMark(d.cde_state)),
            h('td', { class: 'muted small num' }, fmtDate(d.revised_at || d.created_at)))));
        render(wrap, h('table', null,
            h('thead', null, h('tr', null, ['number', 'title', 'revision', 'status', 'state', 'updated'].map((c) => h('th', null, t(`docs.col.${c}`))))),
            tbody));
        summary.textContent = rows.length === 1000 ? t('docs.first_1000') : tn('docs.count', rows.length);
    }

    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
    stateFilter.addEventListener('change', load);
    await load();

    return h('div', null,
        h('div', { class: 'page-head' },
            h('div', null,
                h('h1', null, t('docs.title')),
                h('p', null, t('docs.intro'))),
            h('div', { class: 'actions' },
                canWrite(meta) ? h('button', { class: 'primary', onclick: () => registerDialog(ctx) }, t('docs.register')) : null)),
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
        const vals = [meta.project.code, myCode, ...FIELDS.map(([n]) => fd.get(n)), fd.get('number_code') || t('reg.next')];
        render(preview, vals.map((v, i) => h('div', null, h('b', null, v), h('small', null, t(TITLEBLOCK_LABELS[i])))));
    };
    dialog({
        title: t('reg.title'),
        submitLabel: t('reg.title'),
        wide: true,
        build: (body) => {
            form = body.closest('form');
            body.append(
                h('p', { class: 'muted', style: 'margin:0' }, t('reg.note')),
                preview,
                h('div', { class: 'field-row' }, FIELDS.map(([name, f, label]) => field(t(label),
                    select(name, meta.codes.filter((c) => c.field === f).map((c) => [c.code, `${c.code} – ${desc(c)}`]), undefined, { required: true, onchange: update })))),
                h('div', { class: 'field-row' },
                    field(t('reg.number'), h('input', { name: 'number_code', inputmode: 'numeric', dir: 'ltr', pattern: '[0-9]{4,6}', placeholder: t('reg.number_placeholder'), oninput: update }), t('reg.number_hint'))),
                field(t('reg.title_field'), h('input', { name: 'title', required: true, maxlength: 255 })));
            update();
        },
        onSubmit: async (fd) => {
            const body = Object.fromEntries(fd.entries());
            if (!body.number_code) delete body.number_code;
            const doc = await api('POST', `/projects/${pid}/documents`, body);
            toast(t('reg.done', { number: doc.document_number }));
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

    const segs = [doc.project_code, doc.originator_code, doc.volume_code, doc.level_code, doc.type_code, doc.role_code, doc.number_code];
    const titleblock = h('div', { class: 'titleblock', role: 'img',
        'aria-label': latest ? t('doc.aria_revision', { number: doc.document_number, revision: latest.revision_label }) : t('doc.aria_number', { number: doc.document_number }) },
        segs.map((v, i) => h('div', null, h('b', null, v), h('small', null, t(TITLEBLOCK_LABELS[i])))),
        h('div', { class: 'rev' }, h('b', null, latest?.revision_label || '—'), h('small', null, latest ? suitabilityText(meta, latest.suitability_code) : t('doc.no_revision_yet'))));

    function showPreview(rev) {
        selected = rev?.id;
        timeline.querySelectorAll('li').forEach((li) => li.setAttribute('aria-selected', String(li.dataset.id === selected)));
        if (!rev) return render(previewPane, h('div', { class: 'preview-empty' }, mayUpload ? t('doc.upload_first') : t('doc.no_revisions')));
        const src = `/api/revisions/${rev.id}/file?inline=1`;
        if (rev.mime_type === 'application/pdf') render(previewPane, h('iframe', { class: 'preview', src, title: t('doc.preview_of', { revision: rev.revision_label }) }));
        else if (/^image\/(png|jpeg|webp|gif)$/.test(rev.mime_type)) render(previewPane, h('img', { src, alt: t('doc.image_alt', { number: doc.document_number, revision: rev.revision_label }), style: 'max-width:100%;border:1px solid var(--line);border-radius:6px;background:#fff' }));
        else render(previewPane, h('div', { class: 'preview-empty' }, h('div', null, h('p', null, t('doc.no_preview', { file: rev.original_filename })), h('a', { class: 'button', href: `/api/revisions/${rev.id}/file` }, t('doc.download_file')))));
    }

    const timeline = h('ul', { class: 'timeline' }, revisions.map((r) => {
        const suitOptions = meta.suitability.filter((s) =>
            s.revision_prefix === (r.revision_label.startsWith('C') ? 'C' : 'P')
            && ['WIP', 'SHARED', 'PUBLISHED'].indexOf(s.cde_state) >= ['WIP', 'SHARED', 'PUBLISHED'].indexOf(r.cde_state)
            && !(r.revision_label.includes('.') && s.cde_state !== 'WIP'));
        const changeStatus = doc.is_mine && isDC && suitOptions.length > 1
            ? select('suitability', suitOptions.map((s) => [s.code, `${s.code} – ${desc(s)}`]), r.suitability_code, {
                'aria-label': t('doc.change_status', { revision: r.revision_label }),
                onclick: (e) => e.stopPropagation(),
                onchange: async (e) => {
                    try {
                        await api('PATCH', `/revisions/${r.id}`, { suitability_code: e.target.value });
                        toast(t('doc.status_now', { revision: r.revision_label, code: e.target.value }));
                        ctx.refresh();
                    } catch (err) { toast(err.message, 'error'); e.target.value = r.suitability_code; }
                },
            })
            : null;
        const transmitted = transmittals.filter((tr) => tr.revision_id === r.id);
        return h('li', { class: r.cde_state, dataset: { id: r.id }, tabindex: 0, onclick: () => showPreview(r), onkeydown: (e) => { if (e.key === 'Enter') showPreview(r); } },
            h('div', { class: 'rev-line' },
                ltr(r.revision_label, 'rev-label'),
                stateMark(r.cde_state),
                h('span', { title: suitabilityText(meta, r.suitability_code) }, ltr(r.suitability_code)),
                transmitted.flatMap((tr) => (tr.review_codes ? tr.review_codes.split(', ').map(codeMark) : []))),
            h('div', { class: 'meta' }, bidi(r.uploaded_by_name || t('common.unknown')), sep(), fmtTime(r.created_at)),
            h('div', { class: 'meta' }, ltr(r.original_filename, ''), sep(), fmtBytes(r.size_bytes)),
            h('div', { class: 'hash', dir: 'ltr', title: t('doc.hash_title') }, r.sha256),
            h('div', { class: 'rev-actions' },
                h('a', { href: `/api/revisions/${r.id}/file`, onclick: (e) => e.stopPropagation() }, t('doc.download')),
                changeStatus,
                doc.is_mine && r.cde_state !== 'WIP' && doc.my_role !== 'VIEWER'
                    ? h('a', { href: `#/p/${ctx.pid}/transmittals/new/${r.id}`, onclick: (e) => e.stopPropagation() }, t('doc.transmit'))
                    : null,
                doc.is_mine && r.cde_state === 'WIP' && doc.my_role !== 'VIEWER'
                    ? h('button', { class: 'link danger', onclick: async (e) => {
                        e.stopPropagation();
                        if (!confirm(t('doc.confirm_delete', { revision: r.revision_label }))) return;
                        try { await api('DELETE', `/revisions/${r.id}`); toast(t('doc.deleted', { revision: r.revision_label })); ctx.refresh(); } catch (err) { toast(err.message, 'error'); }
                    } }, t('doc.delete'))
                    : null));
    }));

    const history = transmittals.length
        ? h('div', { class: 'panel' }, h('h2', null, t('doc.transmittals')),
            h('ul', { style: 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px' }, transmittals.map((tr) => {
                const rev = revisions.find((r) => r.id === tr.revision_id);
                return h('li', null,
                    h('a', { href: `#/p/${ctx.pid}/transmittals/${tr.id}` }, ltr(tr.transmittal_number)),
                    ' ', h('span', { class: `tstatus ${tr.status}` }, t(`tstatus.${tr.status}`)),
                    h('div', { class: 'small muted' }, ltr(rev?.revision_label || ''), ' – ', tr.subject));
            })))
        : null;

    const page = h('div', null,
        h('p', { class: 'small', style: 'margin:0 0 8px' }, h('a', { href: `#/p/${ctx.pid}/documents` }, t('doc.back'))),
        h('div', { class: 'page-head', style: 'margin-bottom:4px' },
            h('div', null, h('h1', null, doc.title), h('p', null, t('doc.originated_by', { org: doc.originator_name }))),
            h('div', { class: 'actions' },
                doc.is_mine && doc.my_role !== 'VIEWER' ? h('button', { onclick: () => renameDialog(ctx, doc) }, t('doc.edit_title')) : null,
                mayUpload ? h('button', { class: 'primary', onclick: () => uploadDialog(ctx, doc, latest) }, t('doc.upload_revision')) : null)),
        titleblock,
        h('div', { class: 'doc-grid' },
            h('div', null,
                h('div', { class: 'panel' }, h('h2', null, t('doc.revisions')),
                    revisions.length ? timeline : h('p', { class: 'muted', style: 'margin:0' }, t('doc.no_revisions'))),
                history),
            previewPane));
    showPreview(latest);
    return page;
}

function renameDialog(ctx, doc) {
    dialog({
        title: t('rename.title'),
        submitLabel: t('rename.save'),
        build: (body) => body.append(field(t('reg.title_field'), h('input', { name: 'title', required: true, maxlength: 255, value: doc.title }))),
        onSubmit: async (fd) => {
            await api('PATCH', `/documents/${doc.id}`, { title: fd.get('title') });
            toast(t('rename.saved'));
            ctx.refresh();
        },
    });
}

function uploadDialog(ctx, doc, latest) {
    const { meta } = ctx;
    const afterC = latest?.revision_label.startsWith('C');
    const groups = ['WIP', 'SHARED', 'PUBLISHED'].map((st) => h('optgroup', { label: t(`state.${st}`) },
        meta.suitability.filter((s) => s.cde_state === st && (!afterC || s.revision_prefix === 'C'))
            .map((s) => h('option', { value: s.code }, `${s.code} – ${desc(s)}`))));
    const suit = h('select', { name: 'suitability_code', required: true }, groups.filter((g) => g.children.length));
    const status = h('p', { class: 'muted small', style: 'margin:0' });
    dialog({
        title: t('up.title', { number: doc.document_number }),
        submitLabel: t('up.submit'),
        build: (body) => body.append(
            field(t('up.file'), h('input', { name: 'file', type: 'file', required: true })),
            field(t('up.status'), suit, afterC ? t('up.hint_after_c') : t('up.hint')),
            status),
        onSubmit: async (fd) => {
            const file = fd.get('file');
            if (!file || !file.size) throw new Error(t('up.choose_file'));
            status.textContent = t('up.uploading', { file: file.name, size: fmtBytes(file.size) });
            const up = await api('PUT', `/projects/${ctx.pid}/uploads`, file);
            status.textContent = t('up.registering');
            const rev = await api('POST', `/documents/${doc.id}/revisions`, {
                object_key: up.object_key, suitability_code: fd.get('suitability_code'),
                original_filename: file.name, mime_type: file.type || 'application/octet-stream',
            });
            toast(t('up.done', { revision: rev.revision_label }));
            ctx.refresh();
        },
    });
}
