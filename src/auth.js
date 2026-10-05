'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// A dummy hash so login timing is similar whether or not the email exists.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

function createSession(db, userId) {
  const token = newToken();
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(now).toISOString());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, new Date(now + SESSION_TTL_MS).toISOString(), new Date(now).toISOString());
  return { token, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
}

function getSessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.full_name, u.role, u.vendor_id, u.active, s.expires_at,
           v.company_name AS vendor_name, v.status AS vendor_status
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN vendors v ON v.id = u.vendor_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < new Date().toISOString() || !row.active) return null;
  if (row.role === 'vendor' && row.vendor_status !== 'active') return null;
  return row;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// Simple fixed-window limiter for login/registration attempts (in-memory).
class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  hit(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.start > this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
  reset(key) {
    this.hits.delete(key);
  }
}

module.exports = {
  hashPassword, verifyPassword, dummyHash, newToken, sha256, validatePassword,
  createSession, getSessionUser, destroySession, RateLimiter,
};
