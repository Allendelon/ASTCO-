'use strict';
// Failure-injection tests (failure hunt E1-E7): database locks, killed
// connections, concurrent writers, numbering limits and graceful shutdown.
// Creates and drops its own database. Needs TEST_DATABASE_ADMIN_URL.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Client } = require('pg');

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL || 'postgres://postgres@localhost:5432/postgres';
const dbName = `cde_resilience_${process.pid}`;
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
process.env.DATABASE_URL = url.toString();
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cde-storage-'));
process.env.DB_LOCK_TIMEOUT_MS = '1000';      // keep lock tests fast
process.env.DB_CONNECT_TIMEOUT_MS = '2000';
// The flood test makes many failed sign-ins from 127.0.0.1; keep the per-client limit out of the way.
process.env.LOGIN_MAX_FAILURES_PER_IP = '100000';

let server, base, seedData, pool;

async function sql(query, params, database = url.toString()) {
    const c = new Client({ connectionString: database });
    await c.connect();
    try { return await c.query(query, params); } finally { await c.end(); }
}

before(async () => {
    await sql(`DROP DATABASE IF EXISTS ${dbName}`, [], adminUrl);
    await sql(`CREATE DATABASE ${dbName}`, [], adminUrl);
    ({ pool } = require('../src/db'));
    await require('../scripts/migrate').migrate();
    seedData = require('../scripts/seed');
    await seedData.seed();
    server = require('../src/server').createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    server?.close();
    await pool?.end();
    await sql(`DROP DATABASE IF EXISTS ${dbName}`, [], adminUrl);
    fs.rmSync(process.env.STORAGE_DIR, { recursive: true, force: true });
});

function as(email, baseUrl = () => base) {
    let cookie = '';
    const call = async (method, p, body, headers = {}) => {
        const raw = Buffer.isBuffer(body);
        const res = await fetch(baseUrl() + p, {
            method, signal: AbortSignal.timeout(20_000),
            headers: { 'X-CDE-Request': '1', ...(cookie ? { Cookie: cookie } : {}),
                ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        });
        const sc = res.headers.get('set-cookie');
        if (sc) cookie = sc.split(';')[0];
        const type = res.headers.get('content-type') || '';
        return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : null };
    };
    return {
        login: () => call('POST', '/api/auth/login', { email, password: seedData.PASSWORD }),
        get: (p) => call('GET', p),
        post: (p, b) => call('POST', p, b ?? {}),
        upload: async (pid, content) => (await call('PUT', `/api/projects/${pid}/uploads`, Buffer.from(content),
            { 'Content-Type': 'application/octet-stream' })).data.object_key,
        cookie: () => cookie,
    };
}
const pid = () => seedData.PROJECT.id;

// Holds an ACCESS EXCLUSIVE lock on a table until release() is called.
async function lockTable(table) {
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    return { release: async () => { await c.query('COMMIT'); await c.end(); } };
}

test('E1: a held lock fails affected requests fast with 503; the rest of the app keeps working', async () => {
    const dc = as('dc@astco.test'); await dc.login();
    const lock = await lockTable('cde_documents');
    try {
        const t0 = Date.now();
        const blocked = await dc.get(`/api/projects/${pid()}/documents`);
        assert.equal(blocked.status, 503);
        assert.ok(Number(blocked.headers.get('retry-after')) > 0);
        assert.ok(Date.now() - t0 < 5_000, 'fails within the lock timeout, not after the client gives up');
        assert.equal((await dc.get('/api/me')).status, 200, 'unrelated endpoints still answer');
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
    } finally {
        await lock.release();
    }
    assert.equal((await dc.get(`/api/projects/${pid()}/documents`)).status, 200, 'recovers once the lock is gone');
});

test('E3: a connection killed mid-transaction does not crash the process or poison the pool', async () => {
    const dc = as('dc@astco.test'); await dc.login();
    // Give the requests enough lock wait to be killed while blocked.
    const lock = await lockTable('cde_documents');
    const inFlight = Promise.all([1, 2, 3].map(() => dc.get(`/api/projects/${pid()}/documents`)));
    await new Promise((r) => setTimeout(r, 300));
    await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    const killed = await inFlight;
    await lock.release();
    for (const r of killed) assert.equal(r.status, 503);
    for (let i = 0; i < 12; i++) {
        assert.equal((await dc.get(`/api/projects/${pid()}/documents`)).status, 200, 'dead clients are not reused');
    }
});

test('E3 (deterministic): the connection dies while still checked out; withTx rejects, the process survives', async () => {
    // pg emits 'error' on a checked-out Client when its socket ends. Whether
    // that happens before or after release is a race, so the HTTP test above
    // can pass by luck. Here the client stays checked out until the socket
    // has ended, which is the case that crashed the process.
    const { withTx } = require('../src/db');
    const err = await withTx({}, async (db) => {
        const { rows: [{ pid: backend }] } = await db.query('SELECT pg_backend_pid() AS pid');
        await sql('SELECT pg_terminate_backend($1)', [backend]);
        await new Promise((r) => setTimeout(r, 300));
        await db.query('SELECT 1');
    }).then(() => null, (e) => e);
    assert.ok(err, 'the transaction fails');
    const dc = as('dc@astco.test'); await dc.login();
    for (let i = 0; i < 12; i++) assert.equal((await dc.get('/api/me')).status, 200);
});

test('E5: parallel revision uploads to one document all succeed, in order', async () => {
    const dc = as('dc@astco.test'); await dc.login();
    const doc = (await dc.post(`/api/projects/${pid()}/documents`,
        { volume_code: 'PD', level_code: '02', type_code: 'DR', role_code: 'E', title: 'Race target' })).data;
    const keys = await Promise.all([1, 2, 3, 4].map((n) => dc.upload(pid(), `%PDF-1.4 race ${n}`)));
    const revs = await Promise.all(keys.map((k) => dc.post(`/api/documents/${doc.id}/revisions`,
        { object_key: k, suitability_code: 'S2', original_filename: 'r.pdf', mime_type: 'application/pdf' })));
    assert.deepEqual(revs.map((r) => r.status), [201, 201, 201, 201]);
    assert.deepEqual(revs.map((r) => r.data.revision_label).sort(), ['P01', 'P02', 'P03', 'P04']);
});

test('E5: parallel auto-numbered registrations get consecutive numbers', async () => {
    const dc = as('dc@astco.test'); await dc.login();
    const regs = await Promise.all([1, 2, 3, 4].map((i) => dc.post(`/api/projects/${pid()}/documents`,
        { volume_code: 'PD', level_code: '00', type_code: 'SP', role_code: 'M', title: `Parallel ${i}` })));
    assert.deepEqual(regs.map((r) => r.status), [201, 201, 201, 201]);
    assert.deepEqual(regs.map((r) => r.data.document_number.slice(-4)).sort(), ['0001', '0002', '0003', '0004']);
});

test('E6: numbering limits explain what to do instead of naming a constraint', async () => {
    const dc = as('dc@astco.test'); await dc.login();
    const cases = [['P', 99, null, 'S2', 'SHARED', 'S2', /reached P99/],
                   ['P', 1, 99, 'S0', 'WIP', 'S0', /99th work-in-progress version/],
                   ['C', 99, null, 'A1', 'PUBLISHED', 'A1', /reached C99/]];
    for (const [i, [prefix, major, minor, suit, state, nextSuit, expected]] of cases.entries()) {
        const doc = (await dc.post(`/api/projects/${pid()}/documents`,
            { volume_code: 'PD', level_code: 'RF', type_code: 'CA', role_code: 'S', title: `Limit ${i}` })).data;
        // Put the document at the limit directly (as its owner organisation's user).
        const key = require('node:crypto').createHash('sha256').update(`limit ${i}`).digest('hex');
        await sql(`SELECT set_config('app.user_id', '${seedData.USERS[0].id}', false);
                   INSERT INTO cde_uploads (project_id, uploaded_by, object_key, size_bytes, detected_mime)
                   VALUES ('${pid()}', '${seedData.USERS[0].id}', '${key}', 10, 'application/pdf');
                   INSERT INTO cde_document_revisions (document_id, project_id, originator_org_id, revision_prefix,
                       revision_major, revision_minor, suitability_code, cde_state, object_key, sha256, size_bytes,
                       mime_type, original_filename, uploaded_by)
                   VALUES ('${doc.id}', '${pid()}', '${seedData.ORGS[0].id}', '${prefix}', ${major}, ${minor ?? 'NULL'},
                       '${suit}', '${state}', '${key}', decode('${key}', 'hex'), 10, 'application/pdf', 'x.pdf',
                       '${seedData.USERS[0].id}')`);
        const next = await dc.post(`/api/documents/${doc.id}/revisions`, { object_key: await dc.upload(pid(), `%PDF next ${i}`),
            suitability_code: nextSuit, original_filename: 'x.pdf', mime_type: 'application/pdf' });
        assert.equal(next.status, 422);
        assert.match(next.data.error, expected);
        assert.doesNotMatch(next.data.error, /_check/);
    }
});

test('E7: SIGTERM lets an in-flight upload finish, then the process exits cleanly', async () => {
    const port = 20_000 + (process.pid % 20_000);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, PORT: String(port), COOKIE_SECURE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const exited = new Promise((r) => child.once('exit', (code) => r(code)));
    for (let i = 0; i < 100 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));

    const u = as('dc@astco.test', () => `http://127.0.0.1:${port}`);
    assert.equal((await u.login()).status, 200);
    const total = 1024 * 1024, chunk = 128 * 1024;
    const result = new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/projects/${pid()}/uploads`,
            headers: { Cookie: u.cookie(), 'X-CDE-Request': '1', 'Content-Type': 'application/octet-stream', 'Content-Length': total } },
            (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', (e) => resolve(`error ${e.code}`));
        let sent = 0;
        const tick = setInterval(() => {
            if (sent === 2 * chunk) child.kill('SIGTERM');    // shutdown starts mid-upload
            req.write(Buffer.alloc(chunk, 5)); sent += chunk;
            if (sent >= total) { clearInterval(tick); req.end(); }
        }, 100);
    });
    assert.equal(await result, 201, 'the upload in flight completes');
    assert.equal(await exited, 0, 'the process exits cleanly after draining');
    assert.match(log, /Shutdown complete/);
});

test('R3-01: a sign-in flood is shed and does not stall file transfers for signed-in users', async () => {
    const dc = as('dc@astco.test'); await dc.login();
    const key = await dc.upload(pid(), Buffer.alloc(4 * 1024 * 1024, 4).toString('latin1'));
    const doc = (await dc.post(`/api/projects/${pid()}/documents`,
        { volume_code: 'PD', level_code: '01', type_code: 'DR', role_code: 'A', title: 'Flood target' })).data;
    const rev = (await dc.post(`/api/documents/${doc.id}/revisions`,
        { object_key: key, suitability_code: 'S2', original_filename: 'f.bin' })).data;

    const attempts = Array.from({ length: 150 }, (_, i) => fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CDE-Request': '1' },
        body: JSON.stringify({ email: `flood${i}@example.test`, password: 'x' }) }).then((r) => r.status));
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    const file = await dc.get(`/api/revisions/${rev.id}/file`);
    const downloadMs = Date.now() - t0;
    const statuses = await Promise.all(attempts);

    assert.equal(file.status, 200);
    assert.ok(downloadMs < 3000, `download took ${downloadMs} ms during the flood`);
    assert.ok(statuses.filter((s) => s === 503).length > 0, 'excess attempts are shed');
    assert.ok(statuses.every((s) => s === 401 || s === 503));
    assert.equal((await as('dc@astco.test').login()).status, 200, 'sign-in works again once the flood ends');
});

// Starts a second app process on the same database: a second instance
// behind the same load balancer.
async function startInstance(extraEnv = {}) {
    const port = 20_000 + ((process.pid + 7) % 20_000);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, PORT: String(port), COOKIE_SECURE: 'false', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    for (let i = 0; i < 100 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
    return { url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }) };
}

test('ADR-003: sign-in failure limits are shared by all instances', async () => {
    const other = await startInstance();
    try {
        const attempt = (url) => fetch(`${url}/api/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CDE-Request': '1' },
            body: JSON.stringify({ email: 'site@astco.test', password: 'wrong' }) }).then((r) => r.status);
        // 10 failures (the per-account limit), alternating between the two instances.
        for (let i = 0; i < 10; i++) assert.equal(await attempt(i % 2 ? other.url : base), 401);
        assert.equal(await attempt(base), 429, 'this instance counts failures made on the other');
        assert.equal(await attempt(other.url), 429, 'and the other counts this one’s');
    } finally {
        await other.stop();
    }
});
