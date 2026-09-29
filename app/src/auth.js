'use strict';

const crypto = require('node:crypto');
const { withTx } = require('./db');

const SESSION_COOKIE = 'cde_session';
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt, params) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, params.keylen,
            { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 },
            (err, key) => (err ? reject(err) : resolve(key)));
    });
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function verifyPassword(password, stored) {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64url');
    const key = await scrypt(password, Buffer.from(salt, 'base64url'),
        { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length });
    return crypto.timingSafeEqual(key, expected);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

function readCookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
}

function sessionCookie(value, maxAgeSeconds) {
    const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (process.env.NODE_ENV === 'production') parts.push('Secure');
    return parts.join('; ');
}

// A dummy hash so unknown emails take as long as wrong passwords.
let dummyHash;
async function login(email, password, ip) {
    dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'));
    return withTx({ ip }, async (db) => {
        const { rows } = await db.query('SELECT user_id, password_hash FROM auth_lookup_credentials($1)', [email]);
        const ok = await verifyPassword(password, rows[0]?.password_hash ?? dummyHash);
        if (!rows[0] || !ok) return null;
        const token = crypto.randomBytes(32).toString('base64url');
        await db.query('SELECT auth_create_session($1, $2, make_interval(hours => $3), $4)',
            [rows[0].user_id, sha256(token), SESSION_TTL_HOURS, ip || null]);
        return { token, maxAge: SESSION_TTL_HOURS * 3600 };
    });
}

async function logout(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return;
    await withTx({ ip: req.ip }, (db) => db.query('SELECT auth_revoke_session($1)', [sha256(token)]));
}

// Express middleware: sets req.userId or answers 401.
async function requireUser(req, res, next) {
    try {
        const token = readCookie(req, SESSION_COOKIE);
        if (token) {
            const { rows } = await withTx({ ip: req.ip },
                (db) => db.query('SELECT auth_resolve_session($1) AS user_id', [sha256(token)]));
            req.userId = rows[0]?.user_id || null;
        }
        if (!req.userId) return res.status(401).json({ error: 'Sign in to continue.' });
        next();
    } catch (err) {
        next(err);
    }
}

module.exports = { SESSION_COOKIE, hashPassword, verifyPassword, login, logout, requireUser, sessionCookie };
