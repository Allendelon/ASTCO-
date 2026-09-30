'use strict';

const crypto = require('node:crypto');
const { withTx } = require('./db');
const { HttpError, sendError } = require('./http');
const limits = require('./ratelimit');

const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
// A session unused for this long ends, even within its 12-hour lifetime.
const SESSION_IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 60);

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

const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_EMAIL = 254;
const MAX_PASSWORD = 1024;

// Failed sign-ins, counted three ways (successful sign-ins are not counted):
//   - per client (an IPv4 address or an IPv6 /64): credential stuffing;
//   - per account and client: guessing one account from one place;
//   - per account from anywhere: a botnet guessing one account. This limit is
//     higher, because anyone who knows an email can use it to lock that
//     account out for one window. MFA is the real answer (SEC-17).
// The counters are shared by all app instances (Postgres, migration 0012).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_CLIENT = Number(process.env.LOGIN_MAX_FAILURES_PER_IP || 30);
const MAX_PER_ACCOUNT = Number(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT || 10);
const MAX_PER_ACCOUNT_GLOBAL = Number(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT_GLOBAL || 100);

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

class LoginError extends HttpError {
    constructor(status, code, retryAfter) {
        super(status, code);
        this.retryAfter = retryAfter;
    }
}

// A dummy hash so unknown emails take as long as wrong passwords.
let dummyHash;

// scrypt runs on libuv's thread pool (4 threads by default), which also does
// all file-system I/O. Unbounded sign-in attempts from many addresses queued
// seconds of hashing ahead of every file read and write: downloads timed out
// and uploads took seconds for everyone (R3-01). At most HASH_CONCURRENCY
// hashes run at once, so file I/O always has free threads; beyond a short
// queue, sign-in attempts are turned away at once with 503 instead of
// piling up.
const HASH_CONCURRENCY = Number(process.env.PASSWORD_HASH_CONCURRENCY || 2);
const HASH_QUEUE = Number(process.env.PASSWORD_HASH_QUEUE || 32);
let hashing = 0;
const hashWaiters = [];

async function withHashSlot(fn) {
    if (hashing < HASH_CONCURRENCY) {
        hashing += 1;
    } else {
        if (hashWaiters.length >= HASH_QUEUE) {
            throw new LoginError(503, 'busy_signin', 5);
        }
        await new Promise((resolve) => hashWaiters.push(resolve));   // slot handed over on release
    }
    try {
        return await fn();
    } finally {
        const next = hashWaiters.shift();
        if (next) next();
        else hashing -= 1;
    }
}

async function login(email, password, ip) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');
    if (email.length > MAX_EMAIL || password.length > MAX_PASSWORD) {
        throw new LoginError(400, 'credentials_too_long');
    }
    const client = limits.clientKey(ip);
    const keys = {
        client: `login:client:${client}`,
        account: `login:account:${email}|${client}`,
        accountGlobal: `login:account:${email}`,
    };

    // Take a hashing slot first, so attempts shed under load cost no
    // database work. Inside it: one transaction checks the shared limits and
    // looks up the credentials; scrypt then runs outside any transaction,
    // because it takes ~100 ms and must not hold a pooled connection.
    const { cred, ok, upgraded } = await withHashSlot(async () => {
        const { wait, found } = await withTx({ ip }, async (db) => ({
            wait: await limits.blockedFor(db, [[keys.client, MAX_PER_CLIENT], [keys.account, MAX_PER_ACCOUNT],
                [keys.accountGlobal, MAX_PER_ACCOUNT_GLOBAL]]),
            found: (await db.query('SELECT user_id, password_hash FROM auth_lookup_credentials($1)', [email])).rows[0],
        }));
        if (wait) throw new LoginError(429, 'too_many_failed_signins', wait);
        dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'));
        const result = await verifyPassword(password, found?.password_hash ?? dummyHash);
        return {
            cred: found,
            ok: result.ok,
            upgraded: found && result.needsRehash ? await hashPassword(password) : null,
        };
    });
    if (!cred || !ok) {
        await withTx({ ip }, (db) => limits.hit(db, [keys.client, keys.account, keys.accountGlobal], WINDOW_MS));
        return null;
    }
    await withTx({ ip }, (db) => limits.reset(db, keys.account));

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

// Ends every session of the signed-in user (all devices), including this one.
async function logoutEverywhere(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token || !SESSION_TOKEN_RE.test(token)) return 0;
    return withTx({ ip: req.ip, userId: req.userId }, async (db) =>
        (await db.query('SELECT auth_revoke_all_sessions($1) AS n', [sha256(token)])).rows[0].n);
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
        // Tokens are 32 random bytes in base64url (43 characters). Anything
        // else cannot be a session, so it costs no database round trip (R3-02).
        if (token && SESSION_TOKEN_RE.test(token)) {
            const { rows } = await withTx({ ip: req.ip },
                (db) => db.query('SELECT auth_resolve_session($1, make_interval(mins => $2)) AS user_id',
                    [sha256(token), SESSION_IDLE_MINUTES]));
            req.userId = rows[0]?.user_id || null;
        }
        if (!req.userId) return sendError(res, new HttpError(401, 'signin_required'));
        next();
    } catch (err) {
        next(err);
    }
}

module.exports = {
    logoutEverywhere,
    SESSION_COOKIE, COOKIE_SECURE, LoginError, hashPassword, verifyPassword, login, logout, requireUser, sessionCookie,
};
