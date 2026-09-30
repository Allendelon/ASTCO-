import { h, render, api, toast, t, loadLocale, switchLocale } from './lib.js';
import { documentsView, documentView } from './views/documents.js';
import { transmittalsView, transmittalView, newTransmittal } from './views/transmittals.js';
import { inspectionsView } from './views/inspections.js';
import { auditView } from './views/audit.js';

const root = document.getElementById('app');
const state = { me: null, meta: null, metaFor: null };

const LOGO = () => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, a] of [['rect', { x: 2, y: 2, width: 20, height: 20 }], ['path', { d: 'M2 16h20M9 16v6M15 16v6' }]]) {
        const el = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
        el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '2');
        svg.append(el);
    }
    return svg;
};

// Labelled in the language it switches to, so either reader can find it.
const languageButton = (cls = 'lang') => h('button', {
    class: cls, type: 'button', lang: t('lang.switch') === 'English' ? 'en' : 'ar',
    'aria-label': t('lang.switch_label'), onclick: switchLocale,
}, t('lang.switch'));

function loginView() {
    const error = h('div', { class: 'error-box hidden', role: 'alert' });
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            await api('POST', '/auth/login', { email: fd.get('email'), password: fd.get('password') }, { allow401: true });
            await boot();
        } catch (err) {
            error.textContent = err.message;
            error.classList.remove('hidden');
        } finally {
            btn.disabled = false;
        }
    } },
        h('label', null, t('login.email'), h('input', { name: 'email', type: 'email', dir: 'ltr', autocomplete: 'username', required: true, autofocus: true })),
        h('label', null, t('login.password'), h('input', { name: 'password', type: 'password', dir: 'ltr', autocomplete: 'current-password', required: true })),
        error,
        h('button', { class: 'primary', type: 'submit' }, t('login.submit')));

    const block = [['KAFD', 'tb.project'], ['AST', 'tb.originator'], ['T7', 'tb.volume'], ['01', 'tb.level'], ['DR', 'tb.type'], ['M', 'tb.role'], ['0001', 'tb.number']];
    render(root, h('div', { class: 'login' },
        h('section', { class: 'login-art', 'aria-hidden': 'true' },
            h('div', { class: 'titleblock' },
                block.map(([v, l]) => h('div', null, h('b', null, v), h('small', null, t(l)))),
                h('div', { class: 'rev' }, h('b', null, 'P01'), h('small', null, t('tb.revision')))),
            h('p', null, t('login.tagline'))),
        h('section', { class: 'login-form' },
            h('div', { class: 'login-top' },
                h('div', { class: 'brand', style: 'color:var(--ink);padding:0' }, LOGO(), t('app.name')),
                languageButton('lang link')),
            h('h1', null, t('login.title')),
            form)));
}

async function loadMeta(pid) {
    if (state.metaFor !== pid) {
        state.meta = await api('GET', `/projects/${pid}/meta`);
        state.metaFor = pid;
    }
    return state.meta;
}

function shell(pid, section, content) {
    const meta = state.meta;
    const link = (key, labelKey) => h('a', { href: `#/p/${pid}/${key}`, 'aria-current': section === key ? 'page' : null }, t(labelKey));
    const canAudit = ['ADMIN', 'DOC_CONTROLLER'].includes(meta.project.my_role);
    const myOrg = meta.organizations.find((o) => o.id === meta.project.my_org_id);
    return h('div', { class: 'shell' },
        h('aside', { class: 'rail' },
            h('div', { class: 'brand' }, LOGO(), t('app.name')),
            state.me.projects.length > 1
                ? h('select', { 'aria-label': t('nav.project'), onchange: (e) => { location.hash = `#/p/${e.target.value}/documents`; } },
                    state.me.projects.map((p) => h('option', { value: p.id, selected: p.id === pid }, `${p.code} – ${p.name}`)))
                : h('div', { style: 'padding:0 8px' }, h('div', { style: 'color:var(--rail-active);font-weight:600' }, meta.project.code), h('div', { class: 'small' }, meta.project.name)),
            h('nav', { 'aria-label': t('nav.sections') },
                link('documents', 'nav.documents'),
                link('transmittals', 'nav.transmittals'),
                link('inspections', 'nav.inspections'),
                canAudit ? link('audit', 'nav.audit') : null),
            h('div', { class: 'who' },
                h('strong', null, state.me.user.display_name),
                h('span', null, myOrg?.legal_name || ''),
                h('span', { class: 'role' }, t(`role.${meta.project.my_role}`)),
                h('button', { onclick: async () => { await api('POST', '/auth/logout', {}); state.me = null; loginView(); } }, t('account.sign_out')),
                h('button', { onclick: async () => {
                    if (!confirm(t('account.confirm_everywhere'))) return;
                    await api('POST', '/auth/logout-everywhere', {});
                    state.me = null; loginView(); toast(t('account.signed_out_everywhere'));
                } }, t('account.sign_out_everywhere')),
                languageButton())),
        h('main', { id: 'main' }, content));
}

async function route() {
    if (!state.me) return;
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] !== 'p' || !parts[1]) {
        const first = state.me.projects[0];
        if (!first) {
            render(root, h('main', null, h('div', { class: 'empty' }, t('common.no_projects'))));
            return;
        }
        location.replace(`#/p/${first.id}/documents`);
        return;
    }
    const [, pid, section = 'documents', id, sub] = parts;
    try {
        const meta = await loadMeta(pid);
        const ctx = { pid, meta, me: state.me, go: (p) => { location.hash = `#/p/${pid}/${p}`; }, refresh: route };
        const main = h('div', null, h('p', { class: 'muted' }, t('common.loading')));
        render(root, shell(pid, section, main));
        let view;
        if (section === 'documents') view = id ? documentView(ctx, id) : documentsView(ctx);
        else if (section === 'transmittals') view = id === 'new' ? newTransmittal(ctx, sub) : id ? transmittalView(ctx, id) : transmittalsView(ctx);
        else if (section === 'inspections') view = inspectionsView(ctx);
        else if (section === 'audit') view = auditView(ctx);
        else view = Promise.resolve(h('div', { class: 'empty' }, t('common.page_not_found')));
        render(main, await view);
        document.getElementById('main')?.focus?.();
    } catch (err) {
        if (err.status === 401) return;
        render(root, state.meta && state.metaFor === pid
            ? shell(pid, section, h('div', { class: 'error-box' }, err.message))
            : h('main', null, h('div', { class: 'error-box' }, err.message), h('p', null, h('a', { href: '#/' }, t('common.back_to_projects')))));
    }
}

async function boot() {
    try {
        state.me = await api('GET', '/me', undefined, { allow401: true });
    } catch (err) {
        if (err.status === 401) return loginView();
        render(root, h('main', null, h('div', { class: 'error-box' }, t('common.server_unreachable', { detail: err.message }))));
        return;
    }
    state.metaFor = null;
    await route();
}

window.addEventListener('hashchange', route);
window.addEventListener('cde:signed-out', () => {
    if (state.me) { state.me = null; toast(t('common.session_ended'), 'error'); loginView(); }
});
loadLocale().then(boot);
