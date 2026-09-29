'use strict';
// End-to-end API tests against a real PostgreSQL. Creates and drops its own
// database. Needs TEST_DATABASE_ADMIN_URL (a role that can create databases),
// e.g. postgres://postgres@localhost:5432/postgres

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL || 'postgres://postgres@localhost:5432/postgres';
const dbName = `cde_apitest_${process.pid}`;
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-storage-'));

let server, base, seedData, pool;

async function admin(sql) {
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}

before(async () => {
    await admin(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin(`CREATE DATABASE ${dbName}`);
    ({ pool } = require('../src/db'));
    await require('../scripts/migrate').migrate();
    seedData = require('../scripts/seed');
    await seedData.seed();
    const { createApp } = require('../src/server');
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    server?.close();
    await pool?.end();
    await admin(`DROP DATABASE IF EXISTS ${dbName}`);
    fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
});

// Minimal client with its own session cookie.
function as(email) {
    let cookie = '';
    const call = async (method, p, body, headers = {}) => {
        const isRaw = Buffer.isBuffer(body);
        const res = await fetch(base + p, {
            method,
            headers: {
                'X-CDE-Request': '1',
                ...(cookie ? { Cookie: cookie } : {}),
                ...(body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : {}),
                ...headers,
            },
            body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
        });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        const type = res.headers.get('content-type') || '';
        const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
        return { status: res.status, data, headers: res.headers };
    };
    return {
        login: (password = seedData.PASSWORD) => call('POST', '/api/auth/login', { email, password }),
        get: (p) => call('GET', p),
        post: (p, b) => call('POST', p, b ?? {}),
        patch: (p, b) => call('PATCH', p, b),
        del: (p) => call('DELETE', p),
        put: (p, buf, h) => call('PUT', p, buf, h),
        raw: call,
    };
}

const pid = () => seedData.PROJECT.id;

test('sign-in, session and CSRF header', async () => {
    const dc = as('dc@astco.test');
    assert.equal((await dc.get('/api/me')).status, 401);
    assert.equal((await dc.login('wrong')).status, 401);
    assert.equal((await dc.login()).status, 200);
    const me = await dc.get('/api/me');
    assert.equal(me.data.user.display_name, 'Huda Al-Qahtani');
    assert.equal(me.data.projects[0].code, 'KAFD');
    const noHeader = await dc.raw('POST', '/api/auth/logout', {}, { 'X-CDE-Request': '' });
    assert.equal(noHeader.status, 403);
    await dc.post('/api/auth/logout');
    assert.equal((await dc.get('/api/me')).status, 401, 'logout revokes the session server-side');
});

test('WIP stays inside the originating organisation', async () => {
    const dc = as('dc@astco.test'); await dc.login();
    const mep = as('mep@meridian.test'); await mep.login();
    const mine = (await dc.get(`/api/projects/${pid()}/documents`)).data;
    const theirs = (await mep.get(`/api/projects/${pid()}/documents`)).data;
    assert.equal(mine.length, 5);
    assert.ok(mine.some((d) => d.cde_state === 'WIP'));
    assert.ok(theirs.length < mine.length);
    assert.ok(theirs.every((d) => d.cde_state !== 'WIP'));
    const roof = mine.find((d) => d.title.startsWith('Roof'));
    assert.equal((await mep.get(`/api/documents/${roof.id}`)).status, 404);
});

test('register a document, upload revisions, change status', async () => {
    const dc = as('dc@astco.test'); await dc.login();
    const created = await dc.post(`/api/projects/${pid()}/documents`,
        { volume_code: 'T7', level_code: '02', type_code: 'DR', role_code: 'M', title: 'Level 02 HVAC' });
    assert.equal(created.status, 201);
    assert.equal(created.data.document_number, 'KAFD-AST-T7-02-DR-M-0001');

    const again = await dc.post(`/api/projects/${pid()}/documents`,
        { volume_code: 'T7', level_code: '02', type_code: 'DR', role_code: 'M', title: 'x', number_code: '0001' });
    assert.equal(again.status, 409);
    const badCode = await dc.post(`/api/projects/${pid()}/documents`,
        { volume_code: 'T7', level_code: '99', type_code: 'DR', role_code: 'M', title: 'x' });
    assert.equal(badCode.status, 422);

    const docId = created.data.id;
    const upload = async (content) => (await dc.put(`/api/projects/${pid()}/uploads`, Buffer.from(content),
        { 'Content-Type': 'application/octet-stream' })).data;
    const addRev = async (content, suitability_code, name = 'a.pdf', mime = 'application/pdf') =>
        dc.post(`/api/documents/${docId}/revisions`,
            { object_key: (await upload(content)).object_key, suitability_code, original_filename: name, mime_type: mime });

    const labels = [];
    for (const [content, code] of [['v1', 'S0'], ['v2', 'S0'], ['v3', 'S2'], ['v4', 'S0'], ['v5', 'S3'], ['v6', 'A1']]) {
        const r = await addRev(content, code);
        assert.equal(r.status, 201, JSON.stringify(r.data));
        labels.push(r.data.revision_label);
    }
    assert.deepEqual(labels, ['P01.01', 'P01.02', 'P01', 'P02.01', 'P02', 'C01']);
    assert.equal((await addRev('v7', 'S2')).status, 422, 'after C01 only C revisions are allowed');

    const detail = (await dc.get(`/api/documents/${docId}`)).data;
    const p02 = detail.revisions.find((r) => r.revision_label === 'P02');
    assert.equal((await dc.patch(`/api/revisions/${p02.id}`, { suitability_code: 'S4' })).status, 200);
    assert.equal((await dc.patch(`/api/revisions/${p02.id}`, { suitability_code: 'S2' })).status, 200, 'S4 -> S2 stays within SHARED');
    assert.equal((await dc.patch(`/api/revisions/${p02.id}`, { suitability_code: 'S0' })).status, 422, 'cannot go back to WIP');
    assert.equal((await dc.del(`/api/revisions/${p02.id}`)).status, 422, 'shared revisions cannot be deleted');

    // Another organisation cannot add revisions or change status.
    const mep = as('mep@meridian.test'); await mep.login();
    const rev = await mep.post(`/api/documents/${docId}/revisions`,
        { object_key: (await upload('x')).object_key, suitability_code: 'A2', original_filename: 'x.pdf' });
    assert.equal(rev.status, 403);
    assert.equal((await mep.patch(`/api/revisions/${p02.id}`, { suitability_code: 'S4' })).status, 404);
});

test('downloads are audited, hashed, and never rendered as HTML', async () => {
    const dc = as('dc@astco.test'); await dc.login();
    const doc = (await dc.post(`/api/projects/${pid()}/documents`,
        { volume_code: 'PD', level_code: '00', type_code: 'RP', role_code: 'A', title: 'Hostile upload' })).data;
    const html = Buffer.from('<script>alert(1)</script>');
    const up = (await dc.put(`/api/projects/${pid()}/uploads`, html, { 'Content-Type': 'application/octet-stream' })).data;
    const rev = (await dc.post(`/api/documents/${doc.id}/revisions`,
        { object_key: up.object_key, suitability_code: 'S2', original_filename: 'x.html', mime_type: 'text/html' })).data;

    const file = await dc.get(`/api/revisions/${rev.id}/file?inline=1`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/octet-stream');
    assert.match(file.headers.get('content-disposition'), /^attachment/);
    assert.equal(file.headers.get('content-security-policy'), 'sandbox');
    assert.equal(file.headers.get('x-content-sha256'), up.object_key);
    assert.deepEqual(file.data, html);

    const audit = (await dc.get(`/api/projects/${pid()}/audit`)).data;
    assert.ok(audit.some((a) => a.action === 'DOCUMENT_DOWNLOADED' && a.resource_id === rev.id));
});

test('transmittal: issue, review, close', async () => {
    const dc = as('dc@astco.test'); await dc.login();
    const mep = as('mep@meridian.test'); await mep.login();
    const client = as('pm@rda.test'); await client.login();
    const meta = (await dc.get(`/api/projects/${pid()}/meta`)).data;
    const byEmail = (name) => meta.members.find((m) => m.display_name === name).id;

    const shared = (await dc.get(`/api/projects/${pid()}/documents?state=SHARED`)).data.slice(0, 2);
    assert.equal(shared.length, 2);

    const noDue = await dc.post(`/api/projects/${pid()}/transmittals`, {
        subject: 'For approval', reason_for_issue: 'FOR_APPROVAL', revision_ids: shared.map((d) => d.revision_id),
        to: [byEmail('Daniel Okafor')], issue: true,
    });
    assert.equal(noDue.status, 422, 'approval needs a due date');

    const t = await dc.post(`/api/projects/${pid()}/transmittals`, {
        subject: 'L01 MEP drawings for approval', reason_for_issue: 'FOR_APPROVAL', sla_due_date: '2030-01-15',
        revision_ids: shared.map((d) => d.revision_id), to: [byEmail('Daniel Okafor')], cc: [byEmail('Faisal Al-Harbi')],
        issue: true,
    });
    assert.equal(t.status, 201, JSON.stringify(t.data));
    assert.match(t.data.transmittal_number, /^TR-AST-\d{5}$/);

    const inbox = (await mep.get(`/api/projects/${pid()}/transmittals?box=inbox`)).data;
    assert.ok(inbox.some((x) => x.id === t.data.id));

    const ccView = (await client.get(`/api/transmittals/${t.data.id}`)).data;
    assert.equal(ccView.can.respond, false, 'CC recipients do not review');

    const view = (await mep.get(`/api/transmittals/${t.data.id}`)).data;
    assert.equal(view.can.respond, true);
    const missingComment = await mep.post(`/api/transmittals/${t.data.id}/responses`,
        { responses: [{ revision_id: view.items[0].revision_id, review_code: 'CODE_C' }] });
    assert.equal(missingComment.status, 422);
    const ok = await mep.post(`/api/transmittals/${t.data.id}/responses`, {
        responses: view.items.map((i, k) => ({ revision_id: i.revision_id, review_code: k ? 'CODE_B' : 'CODE_A',
                                               comments: k ? 'Coordinate duct with sprinkler main' : '' })),
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));

    const after = (await dc.get(`/api/transmittals/${t.data.id}`)).data;
    assert.equal(after.transmittal.status, 'UNDER_REVIEW');
    assert.equal(after.responses.length, 2);
    assert.equal((await dc.del(`/api/transmittals/${t.data.id}`)).status, 422, 'issued transmittals cannot be deleted');
    assert.equal((await mep.post(`/api/transmittals/${t.data.id}/close`)).status, 404, 'only the sender closes');
    assert.equal((await dc.post(`/api/transmittals/${t.data.id}/close`)).status, 200);
});

test('site inspection pinned to a sheet', async () => {
    const site = as('site@astco.test'); await site.login();
    const mep = as('mep@meridian.test'); await mep.login();
    const meta = (await site.get(`/api/projects/${pid()}/meta`)).data;
    const daniel = meta.members.find((m) => m.display_name === 'Daniel Okafor').id;
    const sheet = (await site.get(`/api/projects/${pid()}/documents`)).data.find((d) => d.title.startsWith('Level 01 HVAC'));

    const bad = await site.post(`/api/projects/${pid()}/inspections`,
        { inspection_type: 'WIR', assigned_to: daniel, sheet_revision_id: sheet.revision_id, sheet_x_norm: 1.5, sheet_y_norm: 0.2 });
    assert.equal(bad.status, 422);
    const created = await site.post(`/api/projects/${pid()}/inspections`, {
        inspection_type: 'WIR', assigned_to: daniel, location_description: 'Riser 2, grid C/4',
        sheet_revision_id: sheet.revision_id, sheet_x_norm: 0.31, sheet_y_norm: 0.62,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.match(created.data.inspection_number, /^WIR-\d{4}$/);
    assert.equal((await mep.patch(`/api/inspections/${created.data.id}`, { status: 'INSPECTED_PASS' })).status, 200);
});

test('audit trail access and verification', async () => {
    const site = as('site@astco.test'); await site.login();
    assert.equal((await site.get(`/api/projects/${pid()}/audit`)).status, 403);
    assert.equal((await site.post(`/api/projects/${pid()}/audit/verify`)).status, 403);
    const pm = as('pm@rda.test'); await pm.login();
    const v = await pm.post(`/api/projects/${pid()}/audit/verify`);
    assert.deepEqual(v.data, { intact: true, first_broken_seq: null });
});

test('nextRevision covers the UK NA sequence', () => {
    const { nextRevision } = require('../src/routes/documents');
    const P = (major, minor = null) => ({ revision_prefix: 'P', revision_major: major, revision_minor: minor, revision_label: 'x' });
    const wip = { cde_state: 'WIP', revision_prefix: 'P' };
    const shared = { cde_state: 'SHARED', revision_prefix: 'P' };
    const pubC = { cde_state: 'PUBLISHED', revision_prefix: 'C' };
    assert.deepEqual(nextRevision(null, wip), ['P', 1, 1]);
    assert.deepEqual(nextRevision(null, shared), ['P', 1, null]);
    assert.deepEqual(nextRevision(null, pubC), ['C', 1, null]);
    assert.deepEqual(nextRevision(P(1, 3), wip), ['P', 1, 4]);
    assert.deepEqual(nextRevision(P(1, 3), shared), ['P', 1, null]);
    assert.deepEqual(nextRevision(P(1), wip), ['P', 2, 1]);
    assert.deepEqual(nextRevision(P(1), shared), ['P', 2, null]);
    assert.deepEqual(nextRevision(P(4), pubC), ['C', 1, null]);
    assert.deepEqual(nextRevision({ ...P(1), revision_prefix: 'C' }, pubC), ['C', 2, null]);
    assert.throws(() => nextRevision({ ...P(1), revision_prefix: 'C' }, shared));
});
