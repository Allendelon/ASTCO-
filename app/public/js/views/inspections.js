import {
    h, render, api, toast, dialog, field, select, fmtDate, fmtDecimal, docNo, ltr, t, enumOptions,
} from '../lib.js';

const PINNABLE = /^image\/(png|jpeg|webp|gif)$/;
const TYPES = ['WIR', 'MIR', 'SAFETY', 'QAQC'];
const pct = (v) => fmtDecimal(v * 100);

function pinboard(revisionId, pins, onPick) {
    const img = h('img', { src: `/api/revisions/${revisionId}/file?inline=1`, alt: t('ins.sheet_alt'), draggable: 'false' });
    const board = h('div', { class: 'pinboard' }, img);
    const place = (x, y, cls, title) => board.append(h('span', { class: `pin ${cls}`, title, style: `left:${x * 100}%;top:${y * 100}%` }));
    for (const p of pins) place(p.x, p.y, p.cls, p.title);
    if (onPick) {
        board.addEventListener('click', (e) => {
            const r = img.getBoundingClientRect();
            const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
            board.querySelectorAll('.pin.new').forEach((n) => n.remove());
            place(x, y, 'new pending', t('ins.new_pin'));
            onPick(x, y);
        });
    } else {
        board.style.cursor = 'default';
    }
    return board;
}

export async function inspectionsView(ctx) {
    const { pid, meta } = ctx;
    const [rows, docs] = await Promise.all([
        api('GET', `/projects/${pid}/inspections`),
        api('GET', `/projects/${pid}/documents`),
    ]);
    const sheets = docs.filter((d) => d.shared_revision_id && PINNABLE.test(d.shared_mime_type || ''));

    const pinnedSheets = [...new Map(rows.filter((r) => r.sheet_revision_id && PINNABLE.test(r.sheet_mime_type || ''))
        .map((r) => [r.sheet_revision_id, `${r.sheet_document_number} ${r.sheet_revision_label}`])).entries()];
    const boardWrap = h('div', { style: 'margin-bottom:16px' });
    const showSheet = (rid) => {
        if (!rid) return render(boardWrap);
        const pins = rows.filter((r) => r.sheet_revision_id === rid).map((r) => ({
            x: r.sheet_x_norm, y: r.sheet_y_norm, title: `${r.inspection_number} ${t(`istatus.${r.status}`)}`,
            cls: r.status === 'INSPECTED_PASS' ? 'pass' : r.status === 'REQUESTED' ? 'pending' : '',
        }));
        render(boardWrap, h('div', { class: 'panel' }, pinboard(rid, pins),
            h('p', { class: 'small muted', style: 'margin:8px 0 0' }, t('ins.legend'))));
    };
    const sheetPicker = pinnedSheets.length
        ? select('sheet', [['', t('ins.hide_sheet')], ...pinnedSheets], pinnedSheets[0][0], { 'aria-label': t('ins.show_pins'), onchange: (e) => showSheet(e.target.value) })
        : null;
    if (pinnedSheets.length) showSheet(pinnedSheets[0][0]);

    const setStatus = async (r, status) => {
        try {
            await api('PATCH', `/inspections/${r.id}`, { status });
            toast(t('ins.marked', { number: r.inspection_number, status }));
            ctx.refresh();
        } catch (err) { toast(err.message, 'error'); }
    };

    const table = rows.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ['number', 'type', 'location', 'pinned', 'assigned', 'status', 'raised', null].map((x) => h('th', null, x && t(`ins.col.${x}`))))),
            h('tbody', null, rows.map((r) => h('tr', null,
                h('td', { class: 'num' }, ltr(r.inspection_number)),
                h('td', { class: 'small' }, t(`itype.${r.inspection_type}`)),
                h('td', null, r.location_description || '–'),
                h('td', { class: 'small' },
                    r.sheet_document_number ? h('div', null, docNo(r.sheet_document_number), ' ', ltr(r.sheet_revision_label, '')) : null,
                    r.ifc_global_id ? h('div', null, h('bdi', { class: 'mono', dir: 'ltr', title: t('ins.ifc_in', { number: r.model_document_number }) }, r.ifc_global_id)) : null,
                    !r.sheet_document_number && !r.ifc_global_id ? '–' : null),
                h('td', { class: 'small' }, r.assigned_to_name),
                h('td', null, h('span', { class: `istatus ${r.status}` }, t(`istatus.${r.status}`))),
                h('td', { class: 'small muted num' }, fmtDate(r.created_at), h('div', null, r.created_by_name)),
                h('td', { class: 'num' }, r.can_update && r.status === 'REQUESTED'
                    ? h('div', { class: 'actions' },
                        h('button', { onclick: () => setStatus(r, 'INSPECTED_PASS') }, t('ins.pass')),
                        h('button', { class: 'danger', onclick: () => setStatus(r, 'INSPECTED_FAIL') }, t('ins.fail')))
                    : null))))))
        : h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, h('p', null, t('ins.empty'))));

    return h('div', null,
        h('div', { class: 'page-head' },
            h('div', null, h('h1', null, t('ins.title')),
                h('p', null, t('ins.intro'))),
            h('div', { class: 'actions' },
                sheetPicker,
                meta.project.my_role !== 'VIEWER' ? h('button', { class: 'primary', onclick: () => requestDialog(ctx, sheets, docs) }, t('ins.request')) : null)),
        boardWrap,
        table);
}

function requestDialog(ctx, sheets, docs) {
    const { meta, pid } = ctx;
    const models = docs.filter((d) => d.type_code === 'M3' && d.shared_revision_id);
    let pick = null;
    const hint = h('p', { class: 'small muted', style: 'margin:0' });
    const boardSlot = h('div');
    const sheetSelect = select('sheet_revision_id',
        [['', t('ins.no_sheet')], ...sheets.map((d) => [d.shared_revision_id, `${d.document_number} ${d.shared_revision_label} – ${d.title}`])], '',
        { onchange: (e) => {
            pick = null;
            if (!e.target.value) { render(boardSlot); hint.textContent = ''; return; }
            hint.textContent = t('ins.click_sheet');
            render(boardSlot, pinboard(e.target.value, [], (x, y) => { pick = { x, y }; hint.textContent = t('ins.pinned_at', { x: pct(x), y: pct(y) }); }));
        } });

    dialog({
        title: t('ins.request'),
        submitLabel: t('ins.request'),
        wide: true,
        build: (body) => body.append(
            h('div', { class: 'field-row' },
                field(t('ins.type'), select('inspection_type', enumOptions('itype', TYPES), 'WIR', { required: true })),
                field(t('ins.assign'), select('assigned_to', [['', t('ins.choose_person')], ...meta.members.map((m) => [m.id, m.display_name])], '', { required: true }))),
            field(t('ins.location'), h('input', { name: 'location_description', placeholder: t('ins.location_ph') })),
            field(t('ins.sheet'), sheetSelect, t(sheets.length ? 'ins.sheet_hint' : 'ins.no_sheets')),
            hint, boardSlot,
            models.length ? h('div', { class: 'field-row' },
                field(t('ins.model'), select('model_revision_id', [['', t('ins.no_model')], ...models.map((d) => [d.shared_revision_id, `${d.document_number} ${d.shared_revision_label}`])], '')),
                field(t('ins.ifc'), h('input', { name: 'ifc_global_id', dir: 'ltr', pattern: '[0-3][0-9A-Za-z_$]{21}', maxlength: 22, placeholder: t('ins.ifc_ph') }))) : null),
        onSubmit: async (fd) => {
            const body = Object.fromEntries(fd.entries());
            if (body.sheet_revision_id) {
                if (!pick) throw new Error(t('ins.need_pin'));
                Object.assign(body, { sheet_page: 1, sheet_x_norm: pick.x, sheet_y_norm: pick.y });
            }
            if (!body.ifc_global_id) { delete body.ifc_global_id; delete body.model_revision_id; }
            if (body.ifc_global_id && !body.model_revision_id) throw new Error(t('ins.need_model'));
            const r = await api('POST', `/projects/${pid}/inspections`, body);
            toast(t('ins.requested', { number: r.inspection_number }));
            ctx.refresh();
        },
    });
}
