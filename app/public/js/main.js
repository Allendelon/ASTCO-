import { h, render, api, toast } from './lib.js';
import { documentsView, documentView } from './views/documents.js';
import { transmittalsView, transmittalView, newTransmittal } from './views/transmittals.js';
import { inspectionsView } from './views/inspections.js';
import { auditView } from './views/audit.js';

const root = document.getElementById('app');
const ROLE_LABEL = { ADMIN: 'Project admin', DOC_CONTROLLER: 'Document controller', MEMBER: 'Member', VIEWER: 'Viewer' };
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

function loginView() {
    const error = h('div', { class: 'error-box hidden', role: 'alert' });
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const btn = form.querySelector('button');
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
        h('label', null, 'Email', h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true, autofocus: true })),
        h('label', null, 'Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
        error,
        h('button', { class: 'primary', type: 'submit' }, 'Sign in'));

    const block = [['KAFD', 'Project'], ['AST', 'Originator'], ['T7', 'Volume'], ['01', 'Level'], ['DR', 'Type'], ['M', 'Role'], ['0001', 'Number']];
    render(root, h('div', { class: 'login' },
        h('section', { class: 'login-art', 'aria-hidden': 'true' },
            h('div', { class: 'titleblock' },
                block.map(([v, l]) => h('div', null, h('b', null, v), h('small', null, l))),
                h('div', { class: 'rev' }, h('b', null, 'P01'), h('small', null, 'Revision'))),
            h('p', null, 'Every drawing, model and report on the project, with its revision history, review codes and who opened it.')),
        h('section', { class: 'login-form' },
            h('div', { class: 'brand', style: 'color:var(--ink);padding:0' }, LOGO(), 'ASTCO CDE'),
            h('h1', null, 'Sign in'),
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
    const link = (key, label, extra) => h('a', { href: `#/p/${pid}/${key}`, 'aria-current': section === key ? 'page' : null }, label, extra);
    const canAudit = ['ADMIN', 'DOC_CONTROLLER'].includes(meta.project.my_role);
    const myOrg = meta.organizations.find((o) => o.id === meta.project.my_org_id);
    return h('div', { class: 'shell' },
        h('aside', { class: 'rail' },
            h('div', { class: 'brand' }, LOGO(), 'ASTCO CDE'),
            state.me.projects.length > 1
                ? h('select', { 'aria-label': 'Project', onchange: (e) => { location.hash = `#/p/${e.target.value}/documents`; } },
                    state.me.projects.map((p) => h('option', { value: p.id, selected: p.id === pid }, `${p.code} – ${p.name}`)))
                : h('div', { style: 'padding:0 8px' }, h('div', { style: 'color:var(--rail-active);font-weight:600' }, meta.project.code), h('div', { class: 'small' }, meta.project.name)),
            h('nav', { 'aria-label': 'Sections' },
                link('documents', 'Documents'),
                link('transmittals', 'Transmittals'),
                link('inspections', 'Inspections'),
                canAudit ? link('audit', 'Audit trail') : null),
            h('div', { class: 'who' },
                h('strong', null, state.me.user.display_name),
                h('span', null, myOrg?.legal_name || ''),
                h('span', { class: 'role' }, ROLE_LABEL[meta.project.my_role]),
                h('button', { onclick: async () => { await api('POST', '/auth/logout', {}); state.me = null; loginView(); } }, 'Sign out'))),
        h('main', { id: 'main' }, content));
}

async function route() {
    if (!state.me) return;
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] !== 'p' || !parts[1]) {
        const first = state.me.projects[0];
        if (!first) {
            render(root, h('main', null, h('div', { class: 'empty' }, 'You are not a member of any project yet. Ask a project admin to add you.')));
            return;
        }
        location.replace(`#/p/${first.id}/documents`);
        return;
    }
    const [, pid, section = 'documents', id, sub] = parts;
    try {
        const meta = await loadMeta(pid);
        const ctx = { pid, meta, me: state.me, go: (p) => { location.hash = `#/p/${pid}/${p}`; }, refresh: route };
        const main = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
        render(root, shell(pid, section, main));
        let view;
        if (section === 'documents') view = id ? documentView(ctx, id) : documentsView(ctx);
        else if (section === 'transmittals') view = id === 'new' ? newTransmittal(ctx, sub) : id ? transmittalView(ctx, id) : transmittalsView(ctx);
        else if (section === 'inspections') view = inspectionsView(ctx);
        else if (section === 'audit') view = auditView(ctx);
        else view = Promise.resolve(h('div', { class: 'empty' }, 'Page not found.'));
        render(main, await view);
        document.getElementById('main')?.focus?.();
    } catch (err) {
        if (err.status === 401) return;
        render(root, state.meta && state.metaFor === pid
            ? shell(pid, section, h('div', { class: 'error-box' }, err.message))
            : h('main', null, h('div', { class: 'error-box' }, err.message), h('p', null, h('a', { href: '#/' }, 'Back to your projects'))));
    }
}

async function boot() {
    try {
        state.me = await api('GET', '/me', undefined, { allow401: true });
    } catch (err) {
        if (err.status === 401) return loginView();
        render(root, h('main', null, h('div', { class: 'error-box' }, `The server could not be reached: ${err.message}`)));
        return;
    }
    state.metaFor = null;
    await route();
}

window.addEventListener('hashchange', route);
window.addEventListener('cde:signed-out', () => {
    if (state.me) { state.me = null; toast('Your session ended. Sign in again.', 'error'); loginView(); }
});
boot();
