'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

let server;
let base;
let db;

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b); }
  put(p, b) { return this.req('PUT', p, b); }
}

const PW = 'Sup3rSecretPass';
const cat = (kind, name) => db.prepare('SELECT id FROM categories WHERE kind = ? AND name = ?').get(kind, name).id;

async function inviteAndRegister(inviter, invite, extra = {}) {
  const inv = await inviter.post('/api/invitations', invite);
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  const token = new URL(inv.data.register_path, 'http://x').searchParams.get('token');
  const c = new Client();
  const reg = await c.post('/api/auth/register', { token, full_name: 'Person ' + invite.email, password: PW, ...extra });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  return { client: c, token, user: reg.data.user };
}

const ctx = {};

before(async () => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO users (email, password_hash, full_name, role, created_at) VALUES (?, ?, 'Admin', 'admin', ?)")
    .run('admin@astco.test', await hashPassword(PW), new Date().toISOString());
  server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  ctx.admin = new Client();
  assert.equal((await ctx.admin.post('/api/auth/login', { email: 'admin@astco.test', password: PW })).status, 200);
  ctx.manager = (await inviteAndRegister(ctx.admin, { email: 'pm@astco.test', role: 'procurement_manager' })).client;

  const piping = cat('discipline', 'Piping');
  const electrical = cat('discipline', 'Electrical');
  const valves = cat('product_type', 'Valves');
  const switchgear = cat('product_type', 'Switchgear & Panels');
  ctx.cats = { piping, electrical, valves, switchgear };

  // Vendor A: piping + valves (declared at invitation). Vendor B: piping only, but lists a valve product.
  // Vendor C: electrical + switchgear.
  ctx.a = await inviteAndRegister(ctx.manager, { email: 'a@vendor.test', role: 'vendor', company_name: 'Alpha Valves', category_ids: [piping, valves] });
  ctx.b = await inviteAndRegister(ctx.manager, { email: 'b@vendor.test', role: 'vendor', company_name: 'Bravo Piping', category_ids: [piping] });
  ctx.c = await inviteAndRegister(ctx.manager, { email: 'c@vendor.test', role: 'vendor', company_name: 'Charlie Electric', category_ids: [electrical, switchgear] });
});

after(() => new Promise((r) => server.close(() => { db.close(); r(); })));

test('registration is invitation-only and invitations are single use', async () => {
  const anon = new Client();
  assert.equal((await anon.post('/api/auth/register', { token: 'made-up', full_name: 'X', password: PW })).status, 404);
  const reuse = await new Client().post('/api/auth/register', { token: ctx.a.token, full_name: 'X', password: PW });
  assert.equal(reuse.status, 410);
});

test('only managers/admins can invite, and managers cannot mint managers', async () => {
  assert.equal((await ctx.a.client.post('/api/invitations', { email: 'x@y.test', role: 'vendor', company_name: 'X' })).status, 403);
  assert.equal((await ctx.manager.post('/api/invitations', { email: 'x@y.test', role: 'procurement_manager' })).status, 403);
});

test('vendors cannot reach procurement endpoints', async () => {
  for (const p of ['/api/vendors', '/api/rfqs', '/api/catalog', '/api/invitations', '/api/vendors/1/products']) {
    assert.equal((await ctx.a.client.get(p)).status, 403, p);
  }
  assert.equal((await new Client().get('/api/vendor/products')).status, 401);
});

test('vendor catalog prices are private to the owning vendor', async () => {
  const pA = await ctx.a.client.post('/api/vendor/products', { name: 'Gate Valve 10in 600#', category_id: ctx.cats.valves, unit_price: 1234.5, currency: 'USD', lead_time_days: 42 });
  assert.equal(pA.status, 200, JSON.stringify(pA.data));
  const pB = await ctx.b.client.post('/api/vendor/products', { name: 'Ball Valve 6in', category_id: ctx.cats.valves, unit_price: 777, currency: 'USD' });
  assert.equal(pB.status, 200);

  const listB = await ctx.b.client.get('/api/vendor/products');
  assert.deepEqual(listB.data.products.map((p) => p.name), ['Ball Valve 6in']);
  assert.ok(!JSON.stringify(listB.data).includes('1234.5'));

  // B cannot edit or delete A's product (404, not 403, to avoid confirming it exists).
  const id = pA.data.product.id;
  assert.equal((await ctx.b.client.put(`/api/vendor/products/${id}`, { name: 'hijack', unit_price: 1 })).status, 404);
  assert.equal((await ctx.b.client.req('DELETE', `/api/vendor/products/${id}`)).status, 404);

  // Procurement can see both catalogs.
  const cat = await ctx.manager.get('/api/catalog?q=valve');
  assert.equal(cat.data.products.length, 2);
});

test('matching: AND across kinds, OR within a kind, products count as supply', async () => {
  const { piping, valves, electrical, switchgear } = ctx.cats;
  const names = async (ids) => (await ctx.manager.post('/api/rfqs/match', { category_ids: ids })).data.vendors.map((v) => v.company_name);
  assert.deepEqual(await names([piping, valves]), ['Alpha Valves', 'Bravo Piping']); // Bravo via its valve product
  assert.deepEqual(await names([electrical]), ['Charlie Electric']);
  assert.deepEqual(await names([piping, electrical]), ['Alpha Valves', 'Bravo Piping', 'Charlie Electric']);
  assert.deepEqual(await names([electrical, valves]), []); // nobody is electrical AND valves
  assert.deepEqual(await names([switchgear, electrical]), ['Charlie Electric']);
});

test('RFQ dispatch, sealed quotes, vendor isolation and award', async () => {
  const closesAt = new Date(Date.now() + 3600e3).toISOString();
  const created = await ctx.manager.post('/api/rfqs', {
    title: '10in gate valves', description: 'API 600, 600# RF', quantity: 10, unit: 'EA', closes_at: closesAt,
    category_ids: [ctx.cats.piping, ctx.cats.valves],
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const rfqId = created.data.rfq.id;
  assert.equal(created.data.recipients.length, 2);

  // Charlie was not matched and cannot see or quote on it.
  assert.equal((await ctx.c.client.get(`/api/vendor/rfqs/${rfqId}`)).status, 404);
  assert.equal((await ctx.c.client.put(`/api/vendor/rfqs/${rfqId}/quote`, { unit_price: 1, lead_time_days: 1 })).status, 404);
  assert.equal((await ctx.c.client.get('/api/vendor/rfqs')).data.rfqs.length, 0);

  assert.equal((await ctx.a.client.put(`/api/vendor/rfqs/${rfqId}/quote`, { unit_price: 1000, lead_time_days: 30, currency: 'USD' })).status, 200);
  assert.equal((await ctx.b.client.put(`/api/vendor/rfqs/${rfqId}/quote`, { unit_price: 950, lead_time_days: 45, currency: 'USD' })).status, 200);

  // Vendor B's view contains only its own quote.
  const bView = await ctx.b.client.get(`/api/vendor/rfqs/${rfqId}`);
  assert.equal(bView.data.rfq.my_quote.unit_price, 950);
  assert.ok(!JSON.stringify(bView.data).includes('1000'));

  // Sealed: procurement sees who quoted but not prices until closing.
  let detail = await ctx.manager.get(`/api/rfqs/${rfqId}`);
  assert.equal(detail.data.rfq.quotes_visible, false);
  assert.equal(detail.data.rfq.quotes.length, 0);
  assert.equal(detail.data.rfq.recipients.filter((r) => r.quoted).length, 2);
  assert.equal((await ctx.manager.post(`/api/rfqs/${rfqId}/award`, { quote_id: 1 })).status, 409);

  assert.equal((await ctx.manager.post(`/api/rfqs/${rfqId}/close`)).status, 200);
  assert.equal((await ctx.a.client.put(`/api/vendor/rfqs/${rfqId}/quote`, { unit_price: 1, lead_time_days: 1 })).status, 409);
  detail = await ctx.manager.get(`/api/rfqs/${rfqId}`);
  assert.equal(detail.data.rfq.quotes.length, 2);
  const cheapest = detail.data.rfq.quotes[0];
  assert.equal(cheapest.company_name, 'Bravo Piping');
  assert.equal(cheapest.total_price, 9500);

  assert.equal((await ctx.manager.post(`/api/rfqs/${rfqId}/award`, { quote_id: cheapest.id })).status, 200);
  const aList = await ctx.a.client.get('/api/vendor/rfqs');
  assert.equal(aList.data.rfqs[0].outcome, 'not_awarded');
  assert.ok(!JSON.stringify(aList.data).includes('9500'));
  assert.ok(!JSON.stringify(aList.data).includes('Bravo'));
  assert.equal((await ctx.b.client.get('/api/vendor/rfqs')).data.rfqs[0].outcome, 'awarded');
});

test('suspended vendors are logged out and excluded from matching', async () => {
  const vendorId = ctx.c.user.vendor_id;
  assert.equal((await ctx.manager.post(`/api/vendors/${vendorId}/status`, { status: 'suspended' })).status, 200);
  assert.equal((await ctx.c.client.get('/api/vendor/products')).status, 401);
  const m = await ctx.manager.post('/api/rfqs/match', { category_ids: [ctx.cats.electrical] });
  assert.equal(m.data.vendors.length, 0);
});

test('CSRF guards: non-JSON and cross-origin mutations are rejected', async () => {
  const form = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a' });
  assert.equal(form.status, 415);
  const xo = await fetch(base + '/api/rfqs/match', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.test', cookie: ctx.manager.cookie }, body: '{}' });
  assert.equal(xo.status, 403);
});

test('static files cannot escape the public directory', async () => {
  // Raw request: fetch() would normalise the dot segments before they reach the server.
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fsrc/app.js']) {
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 404, p);
  }
});

test('health check responds without authentication', async () => {
  const res = await new Client().get('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true });
});
