import {
    h, render, api, toast, dialog, field, select, fmtDate, docNo, ISTATUS_LABEL, INSPECTION_TYPE_LABEL,
} from '../lib.js';

const PINNABLE = /^image\/(png|jpeg|webp|gif)$/;

function pinboard(revisionId, pins, onPick) {
    const img = h('img', { src: `/api/revisions/${revisionId}/file?inline=1`, alt: 'Sheet', draggable: 'false' });
    const board = h('div', { class: 'pinboard' }, img);
    const place = (x, y, cls, title) => board.append(h('span', { class: `pin ${cls}`, title, style: `left:${x * 100}%;top:${y * 100}%` }));
    for (const p of pins) place(p.x, p.y, p.cls, p.title);
    if (onPick) {
        board.addEventListener('click', (e) => {
            const r = img.getBoundingClientRect();
            const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
            board.querySelectorAll('.pin.new').forEach((n) => n.remove());
            place(x, y, 'new pending', 'New inspection');
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
            x: r.sheet_x_norm, y: r.sheet_y_norm, title: `${r.inspection_number} ${ISTATUS_LABEL[r.status]}`,
            cls: r.status === 'INSPECTED_PASS' ? 'pass' : r.status === 'REQUESTED' ? 'pending' : '',
        }));
        render(boardWrap, h('div', { class: 'panel' }, pinboard(rid, pins),
            h('p', { class: 'small muted', style: 'margin:8px 0 0' }, 'Blue: requested. Green: passed. Red: failed.')));
    };
    const sheetPicker = pinnedSheets.length
        ? select('sheet', [['', 'Hide sheet'], ...pinnedSheets], pinnedSheets[0][0], { 'aria-label': 'Show pins on sheet', onchange: (e) => showSheet(e.target.value) })
        : null;
    if (pinnedSheets.length) showSheet(pinnedSheets[0][0]);

    const setStatus = async (r, status) => {
        try {
            await api('PATCH', `/inspections/${r.id}`, { status });
            toast(`${r.inspection_number} marked ${ISTATUS_LABEL[status].toLowerCase()}`);
            ctx.refresh();
        } catch (err) { toast(err.message, 'error'); }
    };

    const table = rows.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ['Number', 'Type', 'Location', 'Pinned to', 'Assigned to', 'Status', 'Raised', ''].map((x) => h('th', null, x)))),
            h('tbody', null, rows.map((r) => h('tr', null,
                h('td', { class: 'mono num' }, r.inspection_number),
                h('td', { class: 'small' }, INSPECTION_TYPE_LABEL[r.inspection_type]),
                h('td', null, r.location_description || '–'),
                h('td', { class: 'small' },
                    r.sheet_document_number ? h('div', null, docNo(r.sheet_document_number), ` ${r.sheet_revision_label}`) : null,
                    r.ifc_global_id ? h('div', { class: 'mono', title: `IFC element in ${r.model_document_number}` }, r.ifc_global_id) : null,
                    !r.sheet_document_number && !r.ifc_global_id ? '–' : null),
                h('td', { class: 'small' }, r.assigned_to_name),
                h('td', null, h('span', { class: `istatus ${r.status}` }, ISTATUS_LABEL[r.status])),
                h('td', { class: 'small muted num' }, fmtDate(r.created_at), h('div', null, r.created_by_name)),
                h('td', { class: 'num' }, r.can_update && r.status === 'REQUESTED'
                    ? h('div', { class: 'actions' },
                        h('button', { onclick: () => setStatus(r, 'INSPECTED_PASS') }, 'Pass'),
                        h('button', { class: 'danger', onclick: () => setStatus(r, 'INSPECTED_FAIL') }, 'Fail'))
                    : null))))))
        : h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, h('p', null, 'No inspections have been requested on this project.')));

    return h('div', null,
        h('div', { class: 'page-head' },
            h('div', null, h('h1', null, 'Site inspections'),
                h('p', null, 'Work, material, safety and QA/QC inspections, pinned to the sheet or model element they concern.')),
            h('div', { class: 'actions' },
                sheetPicker,
                meta.project.my_role !== 'VIEWER' ? h('button', { class: 'primary', onclick: () => requestDialog(ctx, sheets, docs) }, 'Request inspection') : null)),
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
        [['', 'No sheet'], ...sheets.map((d) => [d.shared_revision_id, `${d.document_number} ${d.shared_revision_label} – ${d.title}`])], '',
        { onchange: (e) => {
            pick = null;
            if (!e.target.value) { render(boardSlot); hint.textContent = ''; return; }
            hint.textContent = 'Click the sheet to place the pin.';
            render(boardSlot, pinboard(e.target.value, [], (x, y) => { pick = { x, y }; hint.textContent = `Pinned at ${(x * 100).toFixed(1)}%, ${(y * 100).toFixed(1)}%.`; }));
        } });

    dialog({
        title: 'Request inspection',
        submitLabel: 'Request inspection',
        wide: true,
        build: (body) => body.append(
            h('div', { class: 'field-row' },
                field('Type', select('inspection_type', Object.entries(INSPECTION_TYPE_LABEL), 'WIR', { required: true })),
                field('Assign to', select('assigned_to', [['', 'Choose a person'], ...meta.members.map((m) => [m.id, m.display_name])], '', { required: true }))),
            field('Location', h('input', { name: 'location_description', placeholder: 'e.g. Level 01, riser 2, grid C/4' })),
            field('Sheet', sheetSelect, sheets.length ? 'Only shared image sheets can be pinned for now.' : 'No shared image sheets on this project yet.'),
            hint, boardSlot,
            models.length ? h('div', { class: 'field-row' },
                field('Model', select('model_revision_id', [['', 'No model'], ...models.map((d) => [d.shared_revision_id, `${d.document_number} ${d.shared_revision_label}`])], '')),
                field('IFC GlobalId', h('input', { name: 'ifc_global_id', pattern: '[0-3][0-9A-Za-z_$]{21}', maxlength: 22, placeholder: '22 characters' }))) : null),
        onSubmit: async (fd) => {
            const body = Object.fromEntries(fd.entries());
            if (body.sheet_revision_id) {
                if (!pick) throw new Error('Click the sheet to place the pin, or choose "No sheet".');
                Object.assign(body, { sheet_page: 1, sheet_x_norm: pick.x, sheet_y_norm: pick.y });
            }
            if (!body.ifc_global_id) { delete body.ifc_global_id; delete body.model_revision_id; }
            if (body.ifc_global_id && !body.model_revision_id) throw new Error('Choose the model the IFC element belongs to.');
            const r = await api('POST', `/projects/${pid}/inspections`, body);
            toast(`Requested ${r.inspection_number}`);
            ctx.refresh();
        },
    });
}
