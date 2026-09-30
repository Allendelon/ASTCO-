import {
    h, render, api, toast, dialog, field, select, fmtDate, fmtDecimal, docNo, ltr, t, enumOptions,
} from '../lib.js';
import { dataTable } from '../ui/table.js';
import { emptyState } from '../ui/async.js';
import { actionButton } from '../ui/controls.js';

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

    const setStatus = (r, status, variant = '') => actionButton({
        label: t(status === 'INSPECTED_PASS' ? 'ins.pass' : 'ins.fail'), variant,
        onClick: () => api('PATCH', `/inspections/${r.id}`, { status }),
        onDone: () => { toast(t('ins.marked', { number: r.inspection_number, status })); ctx.refresh(); },
    });

    const table = rows.length
        ? dataTable({
            caption: t('ins.title'),
            rows,
            columns: [
                { id: 'number', header: t('ins.col.number'), primary: true, cell: (r) => ltr(r.inspection_number) },
                { id: 'type', header: t('ins.col.type'), className: 'small', cell: (r) => t(`itype.${r.inspection_type}`) },
                { id: 'location', header: t('ins.col.location'), cell: (r) => (r.location_description ? h('span', { dir: 'auto' }, r.location_description) : '–') },
                { id: 'pinned', header: t('ins.col.pinned'), className: 'small', priority: 'low', cell: (r) => [
                    r.sheet_document_number ? h('div', null, docNo(r.sheet_document_number), ' ', ltr(r.sheet_revision_label, '')) : null,
                    r.ifc_global_id ? h('div', null, h('bdi', { class: 'mono', dir: 'ltr', title: t('ins.ifc_in', { number: r.model_document_number }) }, r.ifc_global_id)) : null,
                    !r.sheet_document_number && !r.ifc_global_id ? '–' : null] },
                { id: 'assigned', header: t('ins.col.assigned'), className: 'small', priority: 'low', cell: (r) => r.assigned_to_name },
                { id: 'status', header: t('ins.col.status'), cell: (r) => h('span', { class: `istatus ${r.status}` }, t(`istatus.${r.status}`)) },
                { id: 'raised', header: t('ins.col.raised'), numeric: true, className: 'small muted', priority: 'low',
                  cell: (r) => [fmtDate(r.created_at), h('div', null, r.created_by_name)] },
                { id: 'actions', header: h('span', { class: 'visually-hidden' }, t('common.actions')), numeric: true,
                  cell: (r) => (r.can_update && r.status === 'REQUESTED'
                      ? h('div', { class: 'actions' }, setStatus(r, 'INSPECTED_PASS'), setStatus(r, 'INSPECTED_FAIL', 'danger'))
                      : null) },
            ],
        }).el
        : emptyState({ title: t('ins.empty') });

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
