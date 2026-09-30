// confirmDialog: ask before an irreversible action. Resolves true or false.
//
//   if (!(await confirmDialog({ title: t('doc.delete'), body: t('doc.confirm_delete', { revision }),
//                               confirmLabel: t('doc.delete'), danger: true }))) return;
//
// Replaces window.confirm(), whose buttons are always in the browser's
// language, cannot be styled, and block the page. A dangerous action starts
// with focus on Cancel, so a reflexive Enter does not delete anything. Focus
// returns to the control that opened the dialog.

import { h, t } from '../lib.js';

let seq = 0;

export function confirmDialog({ title, body, confirmLabel, cancelLabel, danger = false }) {
    const id = `cd${++seq}`;
    const opener = document.activeElement;
    return new Promise((resolve) => {
        const cancel = h('button', { type: 'button', onclick: () => dlg.close('cancel') }, cancelLabel || t('common.cancel'));
        const ok = h('button', { type: 'button', class: danger ? 'danger' : 'primary', onclick: () => dlg.close('ok') }, confirmLabel);
        const dlg = h('dialog', { role: 'alertdialog', 'aria-labelledby': `${id}-t`, 'aria-describedby': body ? `${id}-b` : null, class: 'confirm' },
            h('div', { class: 'dlg-head' }, h('h2', { id: `${id}-t` }, title)),
            body ? h('div', { class: 'dlg-body' }, h('p', { id: `${id}-b`, style: 'margin:0' }, body)) : null,
            h('div', { class: 'dlg-foot' }, cancel, ok));
        dlg.addEventListener('close', () => {
            resolve(dlg.returnValue === 'ok');
            dlg.remove();
            if (opener?.isConnected) opener.focus();
        });
        document.body.append(dlg);
        dlg.showModal();
        (danger ? cancel : ok).focus();
    });
}
