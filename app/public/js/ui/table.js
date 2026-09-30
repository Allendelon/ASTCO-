// dataTable: the one way to show a list of records.
//
//   const table = dataTable({
//       caption: t('docs.title'),                       // accessible name, required
//       columns: [
//           { id: 'number', header: t('docs.col.number'), cell: (d) => docNo(d.document_number), primary: true },
//           { id: 'updated', header: t('docs.col.updated'), cell: (d) => fmtDate(d.revised_at), numeric: true, priority: 'low' },
//       ],
//       rowHref: (d) => `#/p/${pid}/documents/${d.id}`,  // optional: whole row opens this
//   });
//   table.setRows(rows);  table.appendRows(more);  parent.append(table.el);
//
// Rows that open something are real links (the primary cell holds an <a>),
// so keyboard, screen reader, middle-click and "open in new tab" all work.
// Clicking elsewhere on the row follows the same link, unless the click was
// on a control in the row or the user was selecting text to copy.

import { h, render } from '../lib.js';

const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [role="button"]';

const cellClass = (c) => [c.numeric ? 'num' : '', c.priority === 'low' ? 'col-low' : '', c.className || ''].filter(Boolean).join(' ') || null;

export function dataTable({ caption, columns, rows = [], rowHref, rowClass }) {
    if (!caption) throw new Error('dataTable needs a caption (its accessible name)');
    const tbody = h('tbody');
    const table = h('table', null,
        h('caption', { class: 'visually-hidden' }, caption),
        h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col', class: cellClass(c) }, c.header ?? '')))),
        tbody);
    const el = h('div', { class: 'table-wrap', role: 'region', 'aria-label': caption }, table);

    // A region that scrolls sideways must be reachable by keyboard (WCAG
    // 2.1.1), but a tab stop on one that does not scroll is just noise.
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => {
            if (el.scrollWidth > el.clientWidth + 1) el.tabIndex = 0; else el.removeAttribute('tabindex');
        }).observe(el);
    }

    const row = (r) => {
        const href = rowHref?.(r);
        return h('tr', { class: [href ? 'has-link' : '', rowClass?.(r) || ''].join(' ').trim() || null },
            columns.map((c) => {
                const content = c.cell(r);
                return h(c.primary ? 'th' : 'td', { scope: c.primary ? 'row' : null, class: cellClass(c) },
                    c.primary && href ? h('a', { href, class: 'row-link', 'data-row-link': '' }, content) : content);
            }));
    };

    if (rowHref) {
        tbody.addEventListener('click', (e) => {
            const tr = e.target.closest('tr');
            if (!tr || e.target.closest(INTERACTIVE)) return;
            if (String(window.getSelection?.() || '')) return;
            const link = tr.querySelector('a[data-row-link]');
            if (!link) return;
            if (e.ctrlKey || e.metaKey || e.shiftKey) window.open(link.href, '_blank', 'noopener');
            else link.click();
        });
    }

    const api = {
        el,
        setRows(list) { render(tbody, list.map(row)); return api; },
        appendRows(list) { tbody.append(...list.map(row)); return api; },
    };
    return api.setRows(rows);
}
