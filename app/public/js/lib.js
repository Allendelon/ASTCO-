// DOM helpers, API client and formatting. All text goes in as text nodes,
// never as HTML, so data from the server cannot inject markup.

export function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        // CSP (style-src 'self') blocks style attributes set as markup;
        // setting them through the CSSOM is allowed.
        else if (k === 'style') el.style.cssText = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

export function render(target, ...children) {
    target.replaceChildren();
    append(target, children);
}

export class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

export async function api(method, path, body, opts = {}) {
    const headers = { 'X-CDE-Request': '1' };
    let payload = body;
    if (body !== undefined && !(body instanceof Blob)) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    } else if (body instanceof Blob) {
        headers['Content-Type'] = 'application/octet-stream';
    }
    const res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !opts.allow401) {
        window.dispatchEvent(new CustomEvent('cde:signed-out'));
    }
    if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status}).`);
    return data;
}

let toastTimer;
export function toast(message, kind = '') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = `show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, kind === 'error' ? 6000 : 3000);
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtDate = (v) => (v ? dateFmt.format(new Date(v.length === 10 ? `${v}T00:00:00` : v)) : '');
export const fmtTime = (v) => (v ? timeFmt.format(new Date(v)) : '');
export function fmtBytes(n) {
    n = Number(n);
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export const STATE_LABEL = { WIP: 'Work in progress', SHARED: 'Shared', PUBLISHED: 'Published', NONE: 'No revision' };
export const TSTATUS_LABEL = { DRAFT: 'Draft', ISSUED: 'Issued', UNDER_REVIEW: 'Under review', CLOSED: 'Closed' };
export const REASON_LABEL = {
    FOR_APPROVAL: 'For approval', FOR_REVIEW: 'For review', FOR_INFORMATION: 'For information',
    FOR_CONSTRUCTION: 'For construction', FOR_TENDER: 'For tender', AS_BUILT: 'As built',
};
export const CODE_LABEL = {
    CODE_A: 'A – Approved', CODE_B: 'B – Approved with comments', CODE_C: 'C – Revise and resubmit', CODE_D: 'D – Rejected',
};
export const ISTATUS_LABEL = { REQUESTED: 'Requested', INSPECTED_PASS: 'Passed', INSPECTED_FAIL: 'Failed' };
export const INSPECTION_TYPE_LABEL = { WIR: 'Work inspection', MIR: 'Material inspection', SAFETY: 'Safety', QAQC: 'QA/QC' };

export const stateMark = (s) => h('span', { class: `state ${s || 'NONE'}` }, STATE_LABEL[s || 'NONE']);
export const codeMark = (c) => h('span', { class: `code ${c}`, title: CODE_LABEL[c] }, c.replace('CODE_', ''));

export function docNo(number) {
    return h('span', { class: 'docno' }, String(number).split('-').map((p) => h('span', null, p)));
}

// Modal dialog. build(body, close) fills it; onSubmit(formData) may throw to show an error.
export function dialog({ title, submitLabel, build, onSubmit, wide }) {
    const errorBox = h('div', { class: 'error-box hidden', role: 'alert' });
    const form = h('form', { class: 'stack', method: 'dialog' });
    const submit = h('button', { class: 'primary', type: 'submit' }, submitLabel);
    const dlg = h('dialog', { 'aria-label': title, style: wide ? 'width:min(860px, calc(100vw - 32px))' : null },
        h('div', { class: 'dlg-head' }, h('h2', null, title)),
        form);
    const body = h('div', { class: 'dlg-body stack' });
    form.append(body,
        h('div', { class: 'dlg-foot' },
            h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
            submit));
    const close = () => dlg.close();
    build(body, close);
    body.prepend(errorBox);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        submit.disabled = true;
        errorBox.classList.add('hidden');
        try {
            await onSubmit(new FormData(form), e.submitter);
            dlg.close();
        } catch (err) {
            errorBox.textContent = err.message;
            errorBox.classList.remove('hidden');
        } finally {
            submit.disabled = false;
        }
    });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    return dlg;
}

export function field(label, control, hint) {
    return h('label', null, label, hint ? h('span', { class: 'hint' }, hint) : null, control);
}

export function select(name, options, value, attrs = {}) {
    return h('select', { name, ...attrs },
        options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
}
