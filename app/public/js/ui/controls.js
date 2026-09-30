// Buttons and choice controls.

import { h, toast } from '../lib.js';
import { confirmDialog } from './dialogs.js';

// actionButton: a button whose action talks to the server.
//
//   actionButton({ label: t('trv.close'), onClick: () => api('POST', url), onDone: ctx.refresh,
//                  confirm: { title: t('trv.close'), body: t('trv.confirm_close'), confirmLabel: t('trv.close') } })
//
// While the action runs the button is busy: a second click is ignored, so a
// double click cannot issue a transmittal twice. It uses aria-disabled, not
// disabled, so keyboard focus stays on the button instead of dropping to the
// page. A failure is reported with toast(); onDone runs only on success.
export function actionButton({ label, onClick, onDone, confirm, variant = '', type = 'button', ...attrs }) {
    const btn = h('button', { type, class: variant || null, ...attrs }, label);
    btn.addEventListener('click', async (e) => {
        if (btn.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
        if (confirm && !(await confirmDialog(confirm))) return;
        btn.setAttribute('aria-disabled', 'true');
        btn.setAttribute('aria-busy', 'true');
        try {
            const result = await onClick(e);
            await onDone?.(result);
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            btn.removeAttribute('aria-disabled');
            btn.removeAttribute('aria-busy');
        }
    });
    return btn;
}

// segmented: pick one of a few views of the same list (Inbox / Sent / All).
//
//   segmented({ label: t('tr.title'), options: [['inbox', t('tr.tab.inbox')], ...], value: 'inbox', onChange: (v) => ... })
//
// Toggle buttons in a labelled group (aria-pressed). Not ARIA tabs: tabs
// promise a tab panel and arrow-key navigation; a filter needs neither.
export function segmented({ label, options, value, onChange }) {
    let current = value;
    const buttons = options.map(([v, text]) => h('button', {
        type: 'button', 'aria-pressed': String(v === current), dataset: { value: v },
        onclick: () => {
            if (v === current) return;
            current = v;
            buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
            onChange(v);
        },
    }, text));
    const el = h('div', { class: 'segmented', role: 'group', 'aria-label': label }, buttons);
    return { el, get value() { return current; } };
}
