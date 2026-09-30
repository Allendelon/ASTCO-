// DOM helpers, API client, i18n and formatting. All text goes in as text
// nodes, never as HTML, so data from the server cannot inject markup.

// ------------------------------------------------------------------ i18n
// ADR-006: strings live in /i18n/<locale>.json, shared with the server's
// error codes. Arabic switches the page to right-to-left. Codes (document
// numbers, revisions, hashes) stay left-to-right in every language.

export const LOCALES = ['en', 'ar'];
let catalog = {};
export let locale = 'en';

function storedLocale() {
    try { return localStorage.getItem('cde.locale'); } catch { return null; }
}

export async function loadLocale() {
    const wanted = storedLocale() || (navigator.language || '').slice(0, 2);
    locale = LOCALES.includes(wanted) ? wanted : 'en';
    const res = await fetch(`/i18n/${locale}.json`, { credentials: 'same-origin' });
    catalog = await res.json();
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    document.title = catalog['app.name'] || 'ASTCO CDE';
}

export function switchLocale() {
    const next = locale === 'ar' ? 'en' : 'ar';
    try { localStorage.setItem('cde.locale', next); } catch { /* storage may be unavailable */ }
    location.reload();
}

// Parameter values that are catalog entries themselves: field names and enum
// values (CDE states, transmittal and inspection statuses).
function labelParam(name, value) {
    if (name === 'field') return catalog[`field.${value}`] ?? value;
    for (const prefix of ['state', 'tstatus', 'istatus']) {
        if (typeof value === 'string' && catalog[`${prefix}.${value}`] !== undefined) return catalog[`${prefix}.${value}`];
    }
    return value;
}

export function t(key, params = {}) {
    const template = catalog[key];
    if (template === undefined) return key;
    return template.replace(/\{(\w+)\}/g, (m, name) =>
        (params[name] === undefined ? m : String(labelParam(name, params[name]))));
}

// Plural-aware: picks key.zero/one/two/few/many/other by the language's rules
// (Arabic uses all six), with {n} available to the template.
export function tn(key, n, params = {}) {
    const form = n === 0 && catalog[`${key}.zero`] !== undefined ? 'zero' : new Intl.PluralRules(locale).select(n);
    const k = catalog[`${key}.${form}`] !== undefined ? `${key}.${form}` : `${key}.other`;
    return t(k, { ...params, n: fmtNumber(n) });
}

// ------------------------------------------------------------------ DOM

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

// A code (document number, revision, hash, filename) that must read
// left-to-right even inside Arabic text.
export const ltr = (text, cls = 'mono') => h('bdi', { class: cls, dir: 'ltr' }, text);
// Text of unknown direction (a person's or company's name) placed inline next
// to other text: isolated, so a Latin name cannot pull an Arabic date into its run.
export const bidi = (text) => h('bdi', null, text);

// Project data with an optional Arabic translation (code lists, suitability).
export const desc = (x) => (locale === 'ar' && x.description_ar) || x.description;

// ------------------------------------------------------------------ API

export class ApiError extends Error {
    constructor(status, message, code) { super(message); this.status = status; this.code = code; }
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
    if (!res.ok) {
        // The server sends a stable code; show it in the user's language.
        const known = data.code && catalog[`err.${data.code}`] !== undefined;
        const message = known ? t(`err.${data.code}`, data.params || {}) : (data.error || t('common.request_failed', { status: res.status }));
        throw new ApiError(res.status, message, data.code);
    }
    return data;
}

// Confirmations ("Review submitted") are polite and fade. Errors are
// assertive and stay until dismissed: a message that disappears while it is
// being read fails WCAG 2.2.1, and errors are the ones people need to read.
let toastTimer;
export function toast(message, kind = '') {
    if (kind === 'error') {
        const box = document.getElementById('alert');
        const close = () => { box.replaceChildren(); document.removeEventListener('keydown', onKey); };
        const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close(); };
        box.replaceChildren(h('div', { class: 'alert-toast' },
            h('span', null, message),
            h('button', { type: 'button', class: 'link', 'aria-label': t('common.dismiss'), onclick: close }, '×')));
        document.addEventListener('keydown', onKey);
        return;
    }
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, 4000);
}

// ------------------------------------------------------------------ formatting
// Gregorian calendar and Latin digits in both languages (ADR-006): contract
// dates are Gregorian, and digits match the ISO document codes beside them.
const intlLocale = () => (locale === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB');
export const fmtNumber = (n) => new Intl.NumberFormat(intlLocale()).format(n);
export const fmtDate = (v) => (v ? new Intl.DateTimeFormat(intlLocale(), { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(v.length === 10 ? `${v}T00:00:00` : v)) : '');
export const fmtTime = (v) => (v ? new Intl.DateTimeFormat(intlLocale(), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    .format(new Date(v)) : '');
export const fmtDecimal = (n, digits = 1) => new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
// List separator between two phrases ("Acme, 3 Mar"): Arabic uses its own comma.
export const sep = () => (locale === 'ar' ? '، ' : ', ');
export function fmtBytes(n) {
    n = Number(n);
    const one = (x) => fmtDecimal(x);
    if (n < 1024) return t('bytes.B', { n: fmtNumber(n) });
    if (n < 1024 ** 2) return t('bytes.KB', { n: one(n / 1024) });
    return t('bytes.MB', { n: one(n / 1024 ** 2) });
}

export const stateMark = (s) => h('span', { class: `state ${s || 'NONE'}` }, t(`state.${s || 'NONE'}`));
export const codeMark = (c) => h('bdi', { class: `code ${c}`, dir: 'ltr', title: t(`code.${c}`) }, c.replace('CODE_', ''));

export function docNo(number) {
    return h('bdi', { class: 'docno', dir: 'ltr' }, String(number).split('-').map((p) => h('span', null, p)));
}

// ------------------------------------------------------------------ forms

let dialogSeq = 0;

// Modal dialog. build(body, close) fills it; onSubmit(formData) may throw to show an error.
export function dialog({ title, submitLabel, build, onSubmit, wide }) {
    const errorBox = h('div', { class: 'error-box hidden', role: 'alert' });
    const form = h('form', { class: 'stack', method: 'dialog' });
    const submit = h('button', { class: 'primary', type: 'submit' }, submitLabel);
    const titleId = `dlg${++dialogSeq}`;
    const opener = document.activeElement;
    const dlg = h('dialog', { 'aria-labelledby': titleId, style: wide ? 'width:min(860px, calc(100vw - 32px))' : null },
        h('div', { class: 'dlg-head' }, h('h2', { id: titleId }, title)),
        form);
    const body = h('div', { class: 'dlg-body stack' });
    form.append(body,
        h('div', { class: 'dlg-foot' },
            h('button', { type: 'button', onclick: () => dlg.close() }, t('common.cancel')),
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
    dlg.addEventListener('close', () => { dlg.remove(); if (opener?.isConnected) opener.focus(); });
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

// Options for an enum whose labels live in the catalog under prefix.
export const enumOptions = (prefix, values) => values.map((v) => [v, t(`${prefix}.${v}`)]);
