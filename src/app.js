'use strict';
// HTTP application: JSON API + static file serving. Built only on node:http primitives.
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const { tx } = require('./db');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 1024 * 1024;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = 'astco_sid';

const PROCUREMENT = ['admin', 'procurement_manager', 'procurement_staff'];
const MANAGERS = ['admin', 'procurement_manager'];
const VENDOR = ['vendor'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();

// ---------- validation helpers ----------
function str(body, key, { required = false, max = 500, def = '' } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `Field "${key}" is required.`);
    return def;
  }
  if (typeof v !== 'string') throw new HttpError(400, `Field "${key}" must be text.`);
  const t = v.trim();
  if (required && !t) throw new HttpError(400, `Field "${key}" is required.`);
  if (t.length > max) throw new HttpError(400, `Field "${key}" exceeds ${max} characters.`);
  return t;
}

function num(body, key, { required = false, min = 0, max = 1e12, integer = false, def = null } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `Field "${key}" is required.`);
    return def;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Field "${key}" must be a number between ${min} and ${max}.`);
  if (integer && !Number.isInteger(n)) throw new HttpError(400, `Field "${key}" must be a whole number.`);
  return n;
}

function isoDate(body, key, { required = false } = {}) {
  const v = str(body, key, { required, max: 40 });
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `Field "${key}" must be a valid date.`);
  return d.toISOString();
}

function idList(body, key) {
  const v = body[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 200 || !v.every((x) => Number.isInteger(x) && x > 0)) {
    throw new HttpError(400, `Field "${key}" must be a list of ids.`);
  }
  return [...new Set(v)];
}

function email(body, key) {
  const v = str(body, key, { required: true, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, 'A valid email address is required.');
  return v;
}

function currency(body, key) {
  const v = str(body, key, { max: 3, def: 'USD' }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(v)) throw new HttpError(400, 'Currency must be a 3-letter ISO code.');
  return v;
}

// ---------- request plumbing ----------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // Invite tokens travel in URLs; never leak them to CDNs via Referer.
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sessionCookie(token, maxAgeSec, secure) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') {
    res.writeHead(302, { ...SECURITY_HEADERS, Location: '/login.html' });
    return res.end();
  }
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'Bad path.' });
  }
  const filePath = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found.' });
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Not found.' });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- domain helpers ----------
function audit(db, user, action, entity, entityId, detail = '') {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user ? user.id : null, action, entity, entityId ?? null, detail, now());
}

function closeExpiredRfqs(db) {
  db.prepare("UPDATE rfqs SET status = 'closed' WHERE status = 'open' AND closes_at <= ?").run(now());
}

function assertCategoriesExist(db, ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  const n = db.prepare(`SELECT COUNT(*) AS n FROM categories WHERE id IN (${placeholders})`).get(...ids).n;
  if (n !== ids.length) throw new HttpError(400, 'One or more categories do not exist.');
}

/**
 * Vendor matching. Selected categories are grouped by kind (discipline, product_type, ...).
 * A vendor matches when, for EVERY kind selected, it supplies AT LEAST ONE of the selected
 * categories of that kind. A vendor "supplies" a category if it declared it, or if it lists an
 * active product in it. Only active vendors are considered.
 */
function matchVendors(db, categoryIds) {
  if (!categoryIds.length) return [];
  const placeholders = categoryIds.map(() => '?').join(',');
  const cats = db.prepare(`SELECT id, kind FROM categories WHERE id IN (${placeholders})`).all(...categoryIds);
  const groups = new Map();
  for (const c of cats) {
    if (!groups.has(c.kind)) groups.set(c.kind, new Set());
    groups.get(c.kind).add(c.id);
  }
  const supplied = db.prepare(`
    SELECT vendor_id, category_id FROM vendor_categories
    UNION
    SELECT vendor_id, category_id FROM products WHERE active = 1 AND category_id IS NOT NULL`).all();
  const byVendor = new Map();
  for (const row of supplied) {
    if (!byVendor.has(row.vendor_id)) byVendor.set(row.vendor_id, new Set());
    byVendor.get(row.vendor_id).add(row.category_id);
  }
  const vendors = db.prepare("SELECT id, company_name, country FROM vendors WHERE status = 'active' ORDER BY company_name").all();
  return vendors.filter((v) => {
    const have = byVendor.get(v.id);
    if (!have) return false;
    for (const ids of groups.values()) {
      let ok = false;
      for (const id of ids) if (have.has(id)) { ok = true; break; }
      if (!ok) return false;
    }
    return true;
  });
}

function rfqCategories(db, rfqId) {
  return db.prepare(`SELECT c.id, c.kind, c.name FROM rfq_categories rc JOIN categories c ON c.id = rc.category_id
                     WHERE rc.rfq_id = ? ORDER BY c.kind, c.name`).all(rfqId);
}

function vendorCategories(db, vendorId) {
  return db.prepare(`SELECT c.id, c.kind, c.name FROM vendor_categories vc JOIN categories c ON c.id = vc.category_id
                     WHERE vc.vendor_id = ? ORDER BY c.kind, c.name`).all(vendorId);
}

function quotesVisible(rfq) {
  return !rfq.sealed || rfq.status !== 'open';
}

// ---------- routes ----------
function buildRoutes(db, opts) {
  const loginLimiter = new auth.RateLimiter(10, 15 * 60 * 1000);
  const routes = [];
  const add = (method, pattern, roles, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
    routes.push({ method, re, keys, roles, handler });
  };

  // ----- auth -----
  add('POST', '/api/auth/login', null, async ({ body, req, res }) => {
    const em = email(body, 'email');
    const pw = str(body, 'password', { required: true, max: 200 });
    const key = `${req.socket.remoteAddress}|${em}`;
    if (!loginLimiter.hit(key)) throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.');
    const user = db.prepare(`SELECT u.*, v.status AS vendor_status FROM users u LEFT JOIN vendors v ON v.id = u.vendor_id
                             WHERE u.email = ?`).get(em);
    const ok = user ? await auth.verifyPassword(pw, user.password_hash) : (await auth.dummyHash(), false);
    if (!ok) throw new HttpError(401, 'Invalid email or password.');
    if (!user.active || (user.role === 'vendor' && user.vendor_status !== 'active')) {
      throw new HttpError(403, 'This account is suspended. Contact ASTCO procurement.');
    }
    loginLimiter.reset(key);
    const s = auth.createSession(db, user.id);
    audit(db, user, 'login', 'user', user.id);
    sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(s.token, s.maxAgeSec, opts.secureCookies) });
  });

  add('POST', '/api/auth/logout', null, ({ req, res }) => {
    auth.destroySession(db, parseCookies(req.headers.cookie)[COOKIE]);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0, opts.secureCookies) });
  });

  add('GET', '/api/auth/me', [...PROCUREMENT, ...VENDOR], ({ user }) => ({ user: publicUser(user) }));

  add('GET', '/api/invitations/lookup', null, ({ query }) => {
    const inv = findUsableInvite(db, query.get('token'));
    return { email: inv.email, role: inv.role, company_name: inv.company_name, joining_existing_vendor: !!inv.vendor_id };
  });

  add('POST', '/api/auth/register', null, async ({ body, req, res }) => {
    if (!loginLimiter.hit(`register|${req.socket.remoteAddress}`)) throw new HttpError(429, 'Too many attempts.');
    const inv = findUsableInvite(db, str(body, 'token', { required: true, max: 100 }));
    const fullName = str(body, 'full_name', { required: true, max: 120 });
    const pw = str(body, 'password', { required: true, max: 200 });
    const pwErr = auth.validatePassword(pw);
    if (pwErr) throw new HttpError(400, pwErr);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(inv.email)) throw new HttpError(409, 'An account already exists for this email.');
    const hash = await auth.hashPassword(pw);
    const userId = tx(db, () => {
      // Re-check inside the transaction so an invite can never be redeemed twice.
      const fresh = db.prepare('SELECT used_at, revoked_at FROM invitations WHERE id = ?').get(inv.id);
      if (fresh.used_at || fresh.revoked_at) throw new HttpError(410, 'This invitation has already been used.');
      let vendorId = null;
      if (inv.role === 'vendor') {
        vendorId = inv.vendor_id;
        if (!vendorId) {
          const companyName = str(body, 'company_name', { max: 160 }) || inv.company_name;
          if (!companyName) throw new HttpError(400, 'Company name is required.');
          vendorId = Number(db.prepare(`INSERT INTO vendors (company_name, contact_email, country, phone, created_at)
                                        VALUES (?, ?, ?, ?, ?)`).run(
            companyName, inv.email, str(body, 'country', { max: 80 }), str(body, 'phone', { max: 40 }), now()).lastInsertRowid);
          const ins = db.prepare('INSERT OR IGNORE INTO vendor_categories (vendor_id, category_id) VALUES (?, ?)');
          const catIds = JSON.parse(inv.category_ids || '[]');
          for (const cid of catIds) {
            if (db.prepare('SELECT 1 FROM categories WHERE id = ?').get(cid)) ins.run(vendorId, cid);
          }
        }
      }
      const id = Number(db.prepare(`INSERT INTO users (email, password_hash, full_name, role, vendor_id, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?)`).run(inv.email, hash, fullName, inv.role, vendorId, now()).lastInsertRowid);
      db.prepare('UPDATE invitations SET used_at = ? WHERE id = ?').run(now(), inv.id);
      audit(db, { id }, 'register', 'user', id, `via invitation #${inv.id}`);
      return id;
    });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const s = auth.createSession(db, userId);
    sendJson(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(s.token, s.maxAgeSec, opts.secureCookies) });
  });

  // ----- taxonomy -----
  add('GET', '/api/categories', [...PROCUREMENT, ...VENDOR], () => ({
    categories: db.prepare('SELECT id, kind, name FROM categories ORDER BY kind, name').all(),
  }));

  add('POST', '/api/categories', MANAGERS, ({ body, user }) => {
    const kind = str(body, 'kind', { required: true, max: 40 }).toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const name = str(body, 'name', { required: true, max: 80 });
    if (db.prepare('SELECT 1 FROM categories WHERE kind = ? AND name = ?').get(kind, name)) throw new HttpError(409, 'Category already exists.');
    const id = Number(db.prepare('INSERT INTO categories (kind, name) VALUES (?, ?)').run(kind, name).lastInsertRowid);
    audit(db, user, 'create', 'category', id, `${kind}: ${name}`);
    return { category: { id, kind, name } };
  });

  // ----- invitations (registration is invitation-only) -----
  add('POST', '/api/invitations', MANAGERS, ({ body, user }) => {
    const em = email(body, 'email');
    const role = str(body, 'role', { required: true, max: 40 });
    const allowed = user.role === 'admin' ? ['vendor', 'procurement_staff', 'procurement_manager', 'admin'] : ['vendor', 'procurement_staff'];
    if (!allowed.includes(role)) throw new HttpError(403, `You cannot invite users with role "${role}".`);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(em)) throw new HttpError(409, 'A user with this email already exists.');
    let vendorId = null;
    let companyName = str(body, 'company_name', { max: 160 });
    const categoryIds = idList(body, 'category_ids');
    assertCategoriesExist(db, categoryIds);
    if (role === 'vendor') {
      vendorId = num(body, 'vendor_id', { integer: true, min: 1 });
      if (vendorId) {
        const v = db.prepare('SELECT company_name FROM vendors WHERE id = ?').get(vendorId);
        if (!v) throw new HttpError(404, 'Vendor not found.');
        companyName = v.company_name;
      } else if (!companyName) {
        throw new HttpError(400, 'Company name is required for a new vendor invitation.');
      }
    }
    const token = auth.newToken();
    const id = tx(db, () => {
      db.prepare("UPDATE invitations SET revoked_at = ? WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL").run(now(), em);
      const rid = Number(db.prepare(`INSERT INTO invitations (token_hash, email, role, company_name, vendor_id, category_ids, invited_by, created_at, expires_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        auth.sha256(token), em, role, companyName, vendorId, JSON.stringify(categoryIds), user.id, now(),
        new Date(Date.now() + INVITE_TTL_MS).toISOString()).lastInsertRowid);
      audit(db, user, 'invite', 'invitation', rid, `${role} ${em}`);
      return rid;
    });
    // The raw token is only ever returned once; the DB stores its hash.
    return { invitation: { id, email: em, role, company_name: companyName }, register_path: `/register.html?token=${token}` };
  });

  add('GET', '/api/invitations', MANAGERS, () => ({
    invitations: db.prepare(`SELECT i.id, i.email, i.role, i.company_name, i.created_at, i.expires_at, i.used_at, i.revoked_at,
                                    u.full_name AS invited_by_name
                             FROM invitations i JOIN users u ON u.id = i.invited_by ORDER BY i.id DESC LIMIT 200`).all(),
  }));

  add('POST', '/api/invitations/:id/revoke', MANAGERS, ({ params, user }) => {
    const r = db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(now(), params.id);
    if (!r.changes) throw new HttpError(404, 'No pending invitation with that id.');
    audit(db, user, 'revoke', 'invitation', params.id);
    return { ok: true };
  });

  // ----- procurement: vendor network -----
  add('GET', '/api/vendors', PROCUREMENT, () => {
    const vendors = db.prepare(`
      SELECT v.id, v.company_name, v.contact_email, v.country, v.phone, v.status, v.created_at,
             (SELECT COUNT(*) FROM products p WHERE p.vendor_id = v.id AND p.active = 1) AS product_count,
             (SELECT COUNT(*) FROM quotes q WHERE q.vendor_id = v.id) AS quote_count
      FROM vendors v ORDER BY v.company_name`).all();
    for (const v of vendors) v.categories = vendorCategories(db, v.id);
    return { vendors };
  });

  add('GET', '/api/vendors/:id/products', PROCUREMENT, ({ params }) => {
    if (!db.prepare('SELECT 1 FROM vendors WHERE id = ?').get(params.id)) throw new HttpError(404, 'Vendor not found.');
    return { products: listProducts(db, 'p.vendor_id = ?', [params.id]) };
  });

  add('POST', '/api/vendors/:id/status', MANAGERS, ({ params, body, user }) => {
    const status = str(body, 'status', { required: true, max: 20 });
    if (!['active', 'suspended'].includes(status)) throw new HttpError(400, 'Status must be active or suspended.');
    const r = db.prepare('UPDATE vendors SET status = ? WHERE id = ?').run(status, params.id);
    if (!r.changes) throw new HttpError(404, 'Vendor not found.');
    if (status === 'suspended') {
      db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE vendor_id = ?)').run(params.id);
    }
    audit(db, user, status === 'active' ? 'reactivate' : 'suspend', 'vendor', params.id);
    return { ok: true };
  });

  add('PUT', '/api/vendors/:id/categories', MANAGERS, ({ params, body, user }) => {
    if (!db.prepare('SELECT 1 FROM vendors WHERE id = ?').get(params.id)) throw new HttpError(404, 'Vendor not found.');
    const ids = idList(body, 'category_ids');
    assertCategoriesExist(db, ids);
    setVendorCategories(db, params.id, ids);
    audit(db, user, 'set_categories', 'vendor', params.id, ids.join(','));
    return { categories: vendorCategories(db, params.id) };
  });

  add('GET', '/api/catalog', PROCUREMENT, ({ query }) => {
    const where = ['p.active = 1', "v.status = 'active'"];
    const args = [];
    const q = (query.get('q') || '').trim().slice(0, 100);
    if (q) {
      where.push("(p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\')");
      const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
      args.push(like, like, like);
    }
    const cat = Number(query.get('category_id'));
    if (Number.isInteger(cat) && cat > 0) { where.push('p.category_id = ?'); args.push(cat); }
    return { products: listProducts(db, where.join(' AND '), args, 300) };
  });

  // ----- procurement: RFQs -----
  add('POST', '/api/rfqs/match', PROCUREMENT, ({ body }) => {
    const ids = idList(body, 'category_ids');
    assertCategoriesExist(db, ids);
    return { vendors: matchVendors(db, ids) };
  });

  add('POST', '/api/rfqs', PROCUREMENT, ({ body, user }) => {
    const title = str(body, 'title', { required: true, max: 200 });
    const description = str(body, 'description', { required: true, max: 5000 });
    const quantity = num(body, 'quantity', { required: true, min: 0.0001 });
    const unit = str(body, 'unit', { max: 20, def: 'EA' });
    const requiredBy = isoDate(body, 'required_by');
    const deliveryLocation = str(body, 'delivery_location', { max: 200 });
    const closesAt = isoDate(body, 'closes_at', { required: true });
    if (closesAt <= now()) throw new HttpError(400, 'Quotation deadline must be in the future.');
    const sealed = body.sealed === undefined ? true : body.sealed === true;
    const categoryIds = idList(body, 'category_ids');
    if (!categoryIds.length) throw new HttpError(400, 'Select at least one vendor category.');
    assertCategoriesExist(db, categoryIds);
    const exclude = new Set(idList(body, 'exclude_vendor_ids'));
    const recipients = matchVendors(db, categoryIds).filter((v) => !exclude.has(v.id));
    if (!recipients.length) throw new HttpError(422, 'No active registered vendor matches the selected categories.');

    const rfq = tx(db, () => {
      const id = Number(db.prepare(`INSERT INTO rfqs (title, description, quantity, unit, required_by, delivery_location, closes_at, sealed, created_by, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        title, description, quantity, unit, requiredBy, deliveryLocation, closesAt, sealed ? 1 : 0, user.id, now()).lastInsertRowid);
      const ref = `RFQ-${new Date().getUTCFullYear()}-${String(id).padStart(4, '0')}`;
      db.prepare('UPDATE rfqs SET ref = ? WHERE id = ?').run(ref, id);
      const insCat = db.prepare('INSERT INTO rfq_categories (rfq_id, category_id) VALUES (?, ?)');
      for (const cid of categoryIds) insCat.run(id, cid);
      const insRec = db.prepare('INSERT INTO rfq_recipients (rfq_id, vendor_id, sent_at) VALUES (?, ?, ?)');
      for (const v of recipients) insRec.run(id, v.id, now());
      audit(db, user, 'dispatch', 'rfq', id, `${ref} to ${recipients.length} vendor(s)`);
      return { id, ref };
    });
    return { rfq, recipients };
  });

  add('GET', '/api/rfqs', PROCUREMENT, () => {
    closeExpiredRfqs(db);
    const rfqs = db.prepare(`
      SELECT r.id, r.ref, r.title, r.quantity, r.unit, r.closes_at, r.required_by, r.sealed, r.status, r.created_at,
             u.full_name AS created_by_name,
             (SELECT COUNT(*) FROM rfq_recipients x WHERE x.rfq_id = r.id) AS recipient_count,
             (SELECT COUNT(*) FROM quotes q WHERE q.rfq_id = r.id) AS quote_count
      FROM rfqs r JOIN users u ON u.id = r.created_by ORDER BY r.id DESC LIMIT 500`).all();
    return { rfqs };
  });

  add('GET', '/api/rfqs/:id', PROCUREMENT, ({ params }) => {
    closeExpiredRfqs(db);
    const rfq = getRfq(db, params.id);
    rfq.categories = rfqCategories(db, rfq.id);
    rfq.recipients = db.prepare(`
      SELECT v.id AS vendor_id, v.company_name, v.country, r.sent_at, r.viewed_at, r.declined_at, r.decline_reason,
             EXISTS (SELECT 1 FROM quotes q WHERE q.rfq_id = r.rfq_id AND q.vendor_id = r.vendor_id) AS quoted
      FROM rfq_recipients r JOIN vendors v ON v.id = r.vendor_id WHERE r.rfq_id = ? ORDER BY v.company_name`).all(rfq.id);
    rfq.quotes_visible = quotesVisible(rfq);
    rfq.quotes = rfq.quotes_visible
      ? db.prepare(`SELECT q.id, q.vendor_id, v.company_name, q.unit_price, q.total_price, q.currency, q.lead_time_days,
                           q.valid_until, q.incoterm, q.notes, q.status, q.submitted_at, q.updated_at
                    FROM quotes q JOIN vendors v ON v.id = q.vendor_id WHERE q.rfq_id = ? ORDER BY q.total_price`).all(rfq.id)
      : [];
    return { rfq };
  });

  add('POST', '/api/rfqs/:id/close', MANAGERS, ({ params, user }) => {
    const r = db.prepare("UPDATE rfqs SET status = 'closed' WHERE id = ? AND status = 'open'").run(params.id);
    if (!r.changes) throw new HttpError(409, 'Only open RFQs can be closed.');
    audit(db, user, 'close', 'rfq', params.id);
    return { ok: true };
  });

  add('POST', '/api/rfqs/:id/cancel', MANAGERS, ({ params, user }) => {
    const r = db.prepare("UPDATE rfqs SET status = 'cancelled' WHERE id = ? AND status IN ('open','closed')").run(params.id);
    if (!r.changes) throw new HttpError(409, 'This RFQ cannot be cancelled.');
    audit(db, user, 'cancel', 'rfq', params.id);
    return { ok: true };
  });

  add('POST', '/api/rfqs/:id/award', MANAGERS, ({ params, body, user }) => {
    closeExpiredRfqs(db);
    const rfq = getRfq(db, params.id);
    if (rfq.status === 'open' && rfq.sealed) throw new HttpError(409, 'Sealed RFQ: close bidding before awarding.');
    if (!['open', 'closed'].includes(rfq.status)) throw new HttpError(409, `RFQ is already ${rfq.status}.`);
    const quoteId = num(body, 'quote_id', { required: true, integer: true, min: 1 });
    const quote = db.prepare('SELECT id, vendor_id FROM quotes WHERE id = ? AND rfq_id = ?').get(quoteId, rfq.id);
    if (!quote) throw new HttpError(404, 'Quote not found on this RFQ.');
    tx(db, () => {
      db.prepare("UPDATE quotes SET status = CASE WHEN id = ? THEN 'awarded' ELSE 'not_awarded' END WHERE rfq_id = ?").run(quote.id, rfq.id);
      db.prepare("UPDATE rfqs SET status = 'awarded', awarded_quote_id = ? WHERE id = ?").run(quote.id, rfq.id);
      audit(db, user, 'award', 'rfq', rfq.id, `quote #${quote.id} vendor #${quote.vendor_id}`);
    });
    return { ok: true };
  });

  add('GET', '/api/audit', MANAGERS, () => ({
    entries: db.prepare(`SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.at, u.full_name, u.role
                         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200`).all(),
  }));

  // ----- vendor portal (every query is scoped to the caller's own vendor_id) -----
  add('GET', '/api/vendor/profile', VENDOR, ({ user }) => {
    const vendor = db.prepare('SELECT id, company_name, contact_email, country, phone, status, created_at FROM vendors WHERE id = ?').get(user.vendor_id);
    vendor.categories = vendorCategories(db, user.vendor_id);
    return { vendor };
  });

  add('PUT', '/api/vendor/profile', VENDOR, ({ user, body }) => {
    db.prepare('UPDATE vendors SET country = ?, phone = ? WHERE id = ?')
      .run(str(body, 'country', { max: 80 }), str(body, 'phone', { max: 40 }), user.vendor_id);
    return { ok: true };
  });

  add('PUT', '/api/vendor/categories', VENDOR, ({ user, body }) => {
    const ids = idList(body, 'category_ids');
    assertCategoriesExist(db, ids);
    setVendorCategories(db, user.vendor_id, ids);
    audit(db, user, 'set_categories', 'vendor', user.vendor_id, ids.join(','));
    return { categories: vendorCategories(db, user.vendor_id) };
  });

  add('GET', '/api/vendor/products', VENDOR, ({ user }) => ({
    products: listProducts(db, 'p.vendor_id = ?', [user.vendor_id]),
  }));

  add('POST', '/api/vendor/products', VENDOR, ({ user, body }) => {
    const p = productFields(db, body);
    const id = Number(db.prepare(`INSERT INTO products (vendor_id, sku, name, description, category_id, unit, unit_price, currency, lead_time_days, moq, active, updated_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      user.vendor_id, p.sku, p.name, p.description, p.category_id, p.unit, p.unit_price, p.currency, p.lead_time_days, p.moq, p.active, now()).lastInsertRowid);
    audit(db, user, 'create', 'product', id, p.name);
    return { product: listProducts(db, 'p.id = ?', [id])[0] };
  });

  add('PUT', '/api/vendor/products/:id', VENDOR, ({ user, body, params }) => {
    const p = productFields(db, body);
    const r = db.prepare(`UPDATE products SET sku = ?, name = ?, description = ?, category_id = ?, unit = ?, unit_price = ?, currency = ?,
                          lead_time_days = ?, moq = ?, active = ?, updated_at = ? WHERE id = ? AND vendor_id = ?`).run(
      p.sku, p.name, p.description, p.category_id, p.unit, p.unit_price, p.currency, p.lead_time_days, p.moq, p.active, now(), params.id, user.vendor_id);
    if (!r.changes) throw new HttpError(404, 'Product not found.');
    audit(db, user, 'update', 'product', params.id, p.name);
    return { product: listProducts(db, 'p.id = ?', [params.id])[0] };
  });

  add('DELETE', '/api/vendor/products/:id', VENDOR, ({ user, params }) => {
    const r = db.prepare('DELETE FROM products WHERE id = ? AND vendor_id = ?').run(params.id, user.vendor_id);
    if (!r.changes) throw new HttpError(404, 'Product not found.');
    audit(db, user, 'delete', 'product', params.id);
    return { ok: true };
  });

  add('GET', '/api/vendor/rfqs', VENDOR, ({ user }) => {
    closeExpiredRfqs(db);
    return {
      rfqs: db.prepare(`
        SELECT r.id, r.ref, r.title, r.quantity, r.unit, r.closes_at, r.required_by, r.status,
               x.sent_at, x.viewed_at, x.declined_at,
               q.id AS quote_id, q.total_price AS my_total, q.currency AS my_currency, q.status AS my_quote_status
        FROM rfq_recipients x
        JOIN rfqs r ON r.id = x.rfq_id
        LEFT JOIN quotes q ON q.rfq_id = r.id AND q.vendor_id = x.vendor_id
        WHERE x.vendor_id = ? ORDER BY r.id DESC`).all(user.vendor_id).map(vendorRfqStatus),
    };
  });

  add('GET', '/api/vendor/rfqs/:id', VENDOR, ({ user, params }) => {
    closeExpiredRfqs(db);
    const rec = db.prepare('SELECT * FROM rfq_recipients WHERE rfq_id = ? AND vendor_id = ?').get(params.id, user.vendor_id);
    if (!rec) throw new HttpError(404, 'RFQ not found.');
    if (!rec.viewed_at) db.prepare('UPDATE rfq_recipients SET viewed_at = ? WHERE rfq_id = ? AND vendor_id = ?').run(now(), params.id, user.vendor_id);
    const r = db.prepare(`SELECT id, ref, title, description, quantity, unit, required_by, delivery_location, closes_at, status, created_at
                          FROM rfqs WHERE id = ?`).get(params.id);
    r.categories = rfqCategories(db, r.id);
    r.declined_at = rec.declined_at;
    const q = db.prepare(`SELECT id, unit_price, total_price, currency, lead_time_days, valid_until, incoterm, notes, status, submitted_at, updated_at
                          FROM quotes WHERE rfq_id = ? AND vendor_id = ?`).get(r.id, user.vendor_id) || null;
    r.my_quote = q;
    vendorRfqStatus(Object.assign(r, { my_quote_status: q && q.status }));
    return { rfq: r };
  });

  add('PUT', '/api/vendor/rfqs/:id/quote', VENDOR, ({ user, params, body }) => {
    closeExpiredRfqs(db);
    const rec = db.prepare('SELECT declined_at FROM rfq_recipients WHERE rfq_id = ? AND vendor_id = ?').get(params.id, user.vendor_id);
    if (!rec) throw new HttpError(404, 'RFQ not found.');
    const rfq = db.prepare('SELECT quantity, status FROM rfqs WHERE id = ?').get(params.id);
    if (rfq.status !== 'open') throw new HttpError(409, 'This RFQ is no longer accepting quotations.');
    const unitPrice = num(body, 'unit_price', { required: true, min: 0 });
    const total = num(body, 'total_price', { min: 0 }) ?? Math.round(unitPrice * rfq.quantity * 100) / 100;
    const fields = [unitPrice, total, currency(body, 'currency'), num(body, 'lead_time_days', { required: true, integer: true, min: 0, max: 3650 }),
      isoDate(body, 'valid_until'), str(body, 'incoterm', { max: 40 }), str(body, 'notes', { max: 3000 })];
    const existing = db.prepare('SELECT id FROM quotes WHERE rfq_id = ? AND vendor_id = ?').get(params.id, user.vendor_id);
    tx(db, () => {
      if (existing) {
        db.prepare(`UPDATE quotes SET unit_price = ?, total_price = ?, currency = ?, lead_time_days = ?, valid_until = ?, incoterm = ?, notes = ?, updated_at = ?
                    WHERE id = ?`).run(...fields, now(), existing.id);
      } else {
        db.prepare(`INSERT INTO quotes (rfq_id, vendor_id, unit_price, total_price, currency, lead_time_days, valid_until, incoterm, notes, submitted_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(params.id, user.vendor_id, ...fields, now(), now());
      }
      db.prepare('UPDATE rfq_recipients SET declined_at = NULL, decline_reason = \'\' WHERE rfq_id = ? AND vendor_id = ?').run(params.id, user.vendor_id);
      audit(db, user, existing ? 'revise_quote' : 'submit_quote', 'rfq', params.id);
    });
    return { ok: true };
  });

  add('POST', '/api/vendor/rfqs/:id/decline', VENDOR, ({ user, params, body }) => {
    closeExpiredRfqs(db);
    const rfq = db.prepare(`SELECT r.status FROM rfqs r JOIN rfq_recipients x ON x.rfq_id = r.id
                            WHERE r.id = ? AND x.vendor_id = ?`).get(params.id, user.vendor_id);
    if (!rfq) throw new HttpError(404, 'RFQ not found.');
    if (rfq.status !== 'open') throw new HttpError(409, 'This RFQ is no longer open.');
    tx(db, () => {
      db.prepare('DELETE FROM quotes WHERE rfq_id = ? AND vendor_id = ?').run(params.id, user.vendor_id);
      db.prepare('UPDATE rfq_recipients SET declined_at = ?, decline_reason = ? WHERE rfq_id = ? AND vendor_id = ?')
        .run(now(), str(body, 'reason', { max: 500 }), params.id, user.vendor_id);
      audit(db, user, 'decline', 'rfq', params.id);
    });
    return { ok: true };
  });

  return routes;
}

function publicUser(u) {
  return { id: u.id, email: u.email, full_name: u.full_name, role: u.role, vendor_id: u.vendor_id, vendor_name: u.vendor_name || null };
}

function findUsableInvite(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) throw new HttpError(404, 'Invitation not found.');
  const inv = db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(auth.sha256(token));
  if (!inv || inv.revoked_at) throw new HttpError(404, 'Invitation not found or revoked.');
  if (inv.used_at) throw new HttpError(410, 'This invitation has already been used.');
  if (inv.expires_at < now()) throw new HttpError(410, 'This invitation has expired. Ask ASTCO procurement for a new one.');
  return inv;
}

function getRfq(db, id) {
  const rfq = db.prepare(`SELECT r.*, u.full_name AS created_by_name FROM rfqs r JOIN users u ON u.id = r.created_by WHERE r.id = ?`).get(id);
  if (!rfq) throw new HttpError(404, 'RFQ not found.');
  return rfq;
}

function setVendorCategories(db, vendorId, ids) {
  tx(db, () => {
    db.prepare('DELETE FROM vendor_categories WHERE vendor_id = ?').run(vendorId);
    const ins = db.prepare('INSERT INTO vendor_categories (vendor_id, category_id) VALUES (?, ?)');
    for (const id of ids) ins.run(vendorId, id);
  });
}

function listProducts(db, where, args, limit = 1000) {
  return db.prepare(`
    SELECT p.id, p.vendor_id, v.company_name, p.sku, p.name, p.description, p.category_id, c.kind AS category_kind,
           c.name AS category_name, p.unit, p.unit_price, p.currency, p.lead_time_days, p.moq, p.active, p.updated_at
    FROM products p JOIN vendors v ON v.id = p.vendor_id LEFT JOIN categories c ON c.id = p.category_id
    WHERE ${where} ORDER BY p.name LIMIT ${Number(limit)}`).all(...args);
}

function productFields(db, body) {
  const categoryId = num(body, 'category_id', { integer: true, min: 1 });
  if (categoryId) assertCategoriesExist(db, [categoryId]);
  return {
    sku: str(body, 'sku', { max: 60 }),
    name: str(body, 'name', { required: true, max: 200 }),
    description: str(body, 'description', { max: 3000 }),
    category_id: categoryId,
    unit: str(body, 'unit', { max: 20, def: 'EA' }),
    unit_price: num(body, 'unit_price', { required: true, min: 0 }),
    currency: currency(body, 'currency'),
    lead_time_days: num(body, 'lead_time_days', { integer: true, min: 0, max: 3650, def: 0 }),
    moq: num(body, 'moq', { integer: true, min: 1, max: 1e9, def: 1 }),
    active: body.active === false ? 0 : 1,
  };
}

// Vendors only learn their own outcome; never the winning vendor or price.
function vendorRfqStatus(r) {
  if (r.status === 'awarded') r.outcome = r.my_quote_status === 'awarded' ? 'awarded' : 'not_awarded';
  else if (r.status === 'cancelled') r.outcome = 'cancelled';
  else r.outcome = null;
  return r;
}

// ---------- app factory ----------
function createApp(db, opts = {}) {
  const routes = buildRoutes(db, { secureCookies: !!opts.secureCookies });

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
        return serveStatic(req, res, pathname);
      }

      const mutating = !['GET', 'HEAD'].includes(req.method);
      if (mutating) {
        // CSRF defence in depth (cookie is also SameSite=Strict): require JSON and same-origin.
        const ct = req.headers['content-type'] || '';
        if (!ct.startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json.');
        const origin = req.headers.origin;
        if (origin) {
          let originHost = null;
          try { originHost = new URL(origin).host; } catch { /* "null" or malformed origin */ }
          if (originHost !== req.headers.host) throw new HttpError(403, 'Cross-origin request rejected.');
        }
      }

      let route = null;
      let params = {};
      let methodMismatch = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.method !== req.method) { methodMismatch = true; continue; }
        route = r;
        r.keys.forEach((k, i) => { params[k] = Number(m[i + 1]); });
        break;
      }
      if (!route) throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? 'Method not allowed.' : 'Not found.');

      let user = null;
      if (route.roles) {
        user = auth.getSessionUser(db, parseCookies(req.headers.cookie)[COOKIE]);
        if (!user) throw new HttpError(401, 'Please sign in.');
        if (!route.roles.includes(user.role)) throw new HttpError(403, 'You do not have access to this resource.');
      }

      const body = mutating ? await readJson(req) : {};
      const result = await route.handler({ req, res, body, params, query: url.searchParams, user });
      if (!res.headersSent && result !== undefined) sendJson(res, 200, result);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err && typeof err.message === 'string' && err.message.includes('constraint failed')) {
        return sendJson(res, 409, { error: 'The request conflicts with existing data.' });
      }
      console.error(err);
      sendJson(res, 500, { error: 'Internal server error.' });
    }
  };
}

module.exports = { createApp, matchVendors, HttpError };
