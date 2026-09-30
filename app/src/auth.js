'use strict';

const crypto = require('node:crypto');
const { withTx } = require('./db');
const { RateLimiter, clientKey } = require('./ratelimit');

const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);

// Cookies are Secure by default. Set COOKIE_SECURE=false only for plain-HTTP
// local development. With Secure, the __Host- prefix makes the browser
// refuse the cookie unless it is Secure, host-only and Path=/, so a sibling
// subdomain cannot set or overwrite it.
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';
const SESSION_COOKIE = COOKIE_SECURE ? '__Host-cde_session' : 'cde_session';

// OWASP Password Storage Cheat Sheet minimum for scrypt: N=2^17, r=8, p=1.
// That needs about 128 MiB per hash; libuv runs at most UV_THREADPOOL_SIZE
// (default 4) at a time.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const MAX_EMAIL = 254;
const MAX_PASSWORD = 1024;

// Failed sign-ins, counted three ways (successful sign-ins are not counted):
//   - per client (an IPv4 address or an IPv6 /64): credential stuffing;
//   - per account and client: guessing one account from one place;
//   - per account from anywhere: a botnet guessing one account. This limit is
//     higher, because anyone who knows an email can use it to lock that
//     account out for one window. MFA is the real answer (SEC-17).
const WINDOW_MS = 15 * 60 * 1000;
const failuresByClient = new RateLimiter({ windowMs: WINDOW_MS, max: Number(process.env.LOGIN_MAX_FAILURES_PER_IP || 30) });
const failuresByAccount = new RateLimiter({ windowMs: WINDOW_MS, max: Number(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT || 10) });
const failuresByAccountGlobal = new RateLimiter({ windowMs: WINDOW_MS, max: Number(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT_GLOBAL || 100) });

function scrypt(password, salt, params) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, params.keylen,
            { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
            (err, key) => (err ? reject(err) : resolve(key)));
    });
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

// Returns { ok, needsRehash }. needsRehash is set when the stored hash uses
// weaker parameters than the current ones.
async function verifyPassword(password, stored) {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return { ok: false, needsRehash: false };
    const expected = Buffer.from(hash, 'base64url');
    const key = await scrypt(password, Buffer.from(salt, 'base64url'),
        { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length });
    const ok = key.length === expected.length && crypto.timingSafeEqual(key, expected);
    return { ok, needsRehash: ok && (Number(N) < SCRYPT.N || Number(r) < SCRYPT.r) };
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

function readCookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
            try {
                return decodeURIComponent(part.slice(i + 1).trim());
            } catch {
                return null;   // malformed escape: treat as no cookie
            }
        }
    }
    return null;
}

function sessionCookie(value, maxAgeSeconds) {
    const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (COOKIE_SECURE) parts.push('Secure');
    return parts.join('; ');
}

class LoginError extends Error {
    constructor(status, message, retryAfter) {
        super(message);
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

// A dummy hash so unknown emails take as long as wrong passwords.
let dummyHash;

async function login(email, password, ip) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');
    if (email.length > MAX_EMAIL || password.length > MAX_PASSWORD) {
        throw new LoginError(400, 'Email or password is too long.');
    }
    const client = clientKey(ip);
    const accountKey = `${email}|${client}`;
    const wait = Math.max(failuresByClient.blockedFor(client), failuresByAccount.blockedFor(accountKey),
        failuresByAccountGlobal.blockedFor(email));
    if (wait) throw new LoginError(429, 'Too many failed sign-in attempts. Try again later.', wait);

    dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'));

    // Look up, then verify outside any transaction: scrypt takes ~100 ms and
    // must not hold a pooled database connection while it runs.
    const cred = await withTx({ ip }, async (db) =>
        (await db.query('SELECT user_id, password_hash FROM auth_lookup_credentials($1)', [email])).rows[0]);
    const { ok, needsRehash } = await verifyPassword(password, cred?.password_hash ?? dummyHash);
    if (!cred || !ok) {
        failuresByClient.hit(client);
        failuresByAccount.hit(accountKey);
        failuresByAccountGlobal.hit(email);
        return null;
    }
    failuresByAccount.reset(accountKey);

    const upgraded = needsRehash ? await hashPassword(password) : null;
    const token = crypto.randomBytes(32).toString('base64url');
    await withTx({ ip }, async (db) => {
        if (upgraded) {
            await db.query('SELECT auth_upgrade_password_hash($1, $2, $3)', [cred.user_id, cred.password_hash, upgraded]);
        }
        await db.query('SELECT auth_create_session($1, $2, make_interval(hours => $3), $4)',
            [cred.user_id, sha256(token), SESSION_TTL_HOURS, ip || null]);
    });
    return { token, maxAge: SESSION_TTL_HOURS * 3600 };
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
        if (token && token.length <= 128) {
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

module.exports = {
    SESSION_COOKIE, COOKIE_SECURE, LoginError, hashPassword, verifyPassword, login, logout, requireUser, sessionCookie,
};
