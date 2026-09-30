// asyncRegion: a part of the page filled from the server, with its loading,
// empty and error states handled the same way everywhere.
//
//   const list = asyncRegion({
//       load: (signal) => api('GET', `/projects/${pid}/documents?${qs()}`, undefined, { signal }),
//       render: (rows) => table.setRows(rows).el,
//       empty: () => emptyState({ title: t('docs.empty') }),
//   });
//   parent.append(list.el);
//   list.reload();            // first load; call again after a filter changes
//
// - First load: a skeleton, shown only if loading takes longer than
//   `delayMs`, so fast responses do not flash.
// - Reload: the current content stays (dimmed, aria-busy) instead of
//   jumping to a skeleton on every keystroke of a search.
// - Overlapping reloads: the older request is aborted, and a late response
//   can never overwrite a newer one.
// - Failure: an error message with a Retry button in place of the content.

import { h, render, t } from '../lib.js';

export function skeleton(lines = 4) {
    return h('div', { class: 'skeleton', 'aria-hidden': 'true' },
        Array.from({ length: lines }, () => h('div', { class: 'skeleton-line' })));
}

export function emptyState({ title, body, action } = {}) {
    return h('div', { class: 'empty' },
        title ? h('p', { class: 'empty-title' }, title) : null,
        body ? h('p', null, body) : null,
        action || null);
}

export function errorState(message, retry) {
    return h('div', { class: 'state-error', role: 'alert' },
        h('p', null, message || t('common.load_failed')),
        retry ? h('button', { type: 'button', onclick: retry }, t('common.retry')) : null);
}

const isEmptyDefault = (data) => Array.isArray(data) && data.length === 0;

export function asyncRegion({ load, render: draw, empty, isEmpty = isEmptyDefault, placeholder = skeleton, delayMs = 150 }) {
    const el = h('div', { class: 'async-region', 'aria-busy': 'false' });
    const status = h('span', { class: 'visually-hidden', role: 'status' });
    let controller = null;
    let generation = 0;
    let hasContent = false;
    let data;

    async function reload() {
        controller?.abort();
        controller = new AbortController();
        const mine = ++generation;
        el.setAttribute('aria-busy', 'true');
        el.classList.toggle('is-stale', hasContent);
        const timer = hasContent ? null : setTimeout(() => {
            if (mine === generation) { render(el, placeholder(), status); status.textContent = t('common.loading'); }
        }, delayMs);
        try {
            const result = await load(controller.signal);
            if (mine !== generation) return data;
            data = result;
            render(el, isEmpty(result) && empty ? empty(result) : draw(result));
            hasContent = true;
        } catch (err) {
            if (err?.name === 'AbortError' || mine !== generation) return data;
            render(el, errorState(err?.message, reload));
            hasContent = false;
        } finally {
            if (mine === generation) {
                clearTimeout(timer);
                el.setAttribute('aria-busy', 'false');
                el.classList.remove('is-stale');
            }
        }
        return data;
    }

    return { el, reload, get data() { return data; } };
}
