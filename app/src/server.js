'use strict';

const path = require('node:path');
const express = require('express');
const auth = require('./auth');
const { pool } = require('./db');
const { HttpError, route, required, errorHandler, sendError } = require('./http');

// Express reads a number as "trust this many hops" and a string as a list of
// trusted proxy addresses, so TRUST_PROXY="1" as a string would silently mean
// "trust the address 1". "true" would trust any X-Forwarded-For a client
// sends, letting them choose the IP recorded in the audit trail.
function parseTrustProxy(value) {
    if (value === undefined || value === '' || value === 'false') return false;
    if (/^\d+$/.test(value)) return Number(value);
    if (value === 'true') {
        throw new Error('TRUST_PROXY=true trusts client-supplied X-Forwarded-For. Set the number of proxy hops (e.g. 1) or the proxy addresses/subnets.');
    }
    return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function createApp() {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

    app.use((req, res, next) => {
        res.set({
            'Content-Security-Policy': [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self'",
                "font-src 'self'",   // fonts are self-hosted (R2-08)
                "img-src 'self' blob: data:",
                "frame-src 'self'",
                "object-src 'none'",
                "frame-ancestors 'self'",
                "base-uri 'none'",
                "form-action 'self'",
            ].join('; '),
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'same-origin',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
            ...(auth.COOKIE_SECURE ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
        });
        next();
    });

    app.get('/healthz', route(async (_req, res) => {
        // While shutting down, report unhealthy so no new traffic arrives.
        if (draining) return res.status(503).json({ ok: false, draining: true });
        await pool.query('SELECT 1');
        res.json({ ok: true });
    }));

    const api = express.Router();
    // Authenticated data must not be stored by browsers or shared caches.
    api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    api.use(express.json({ limit: '1mb' }));

    // CSRF: the session cookie is SameSite=Strict, and every state-changing
    // call must also carry a header a cross-site form cannot set.
    api.use((req, res, next) => {
        if (!['GET', 'HEAD'].includes(req.method) && req.get('X-CDE-Request') !== '1') {
            return sendError(res, new HttpError(403, 'csrf_header_missing'));
        }
        next();
    });

    api.post('/auth/login', route(async (req, res) => {
        const email = required(req.body, 'email');
        const password = required(req.body, 'password');
        let session;
        try {
            session = await auth.login(email, password, req.ip);
        } catch (err) {
            if (!(err instanceof auth.LoginError)) throw err;
            if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
            return sendError(res, err);
        }
        if (!session) return sendError(res, new HttpError(401, 'wrong_credentials'));
        res.set('Set-Cookie', auth.sessionCookie(session.token, session.maxAge)).json({ ok: true });
    }));

    api.post('/auth/logout', route(async (req, res) => {
        await auth.logout(req);
        res.set('Set-Cookie', auth.sessionCookie('', 0)).json({ ok: true });
    }));

    api.use(auth.requireUser);
    api.post('/auth/logout-everywhere', route(async (req, res) => {
        const n = await auth.logoutEverywhere(req);
        res.set('Set-Cookie', auth.sessionCookie('', 0)).json({ ok: true, sessions_ended: n });
    }));
    api.use(require('./routes/projects'));
    api.use(require('./routes/documents'));
    api.use(require('./routes/transmittals'));
    api.use(require('./routes/inspections'));
    api.use(require('./routes/audit'));
    api.use((_req, res) => sendError(res, new HttpError(404, 'not_found')));

    app.use('/api', api);
    app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
    app.use(errorHandler);
    return app;
}

// Row-level security only protects data if the connection's own role is
// restricted. A superuser, a BYPASSRLS role or the table owner would make a
// bug in "SET LOCAL ROLE cde_app" handling a full data breach. Refuse to
// start in production with such a role.
async function checkDatabaseRole() {
    const { rows: [r] } = await pool.query(`
        SELECT r.rolsuper, r.rolbypassrls,
               EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid AND c.relname = 'cde_documents') AS owns_tables,
               pg_has_role(session_user, 'cde_app', 'MEMBER') AS in_app_role
          FROM pg_roles r WHERE r.rolname = session_user`);
    const problems = [];
    if (!r.in_app_role) problems.push('is not a member of cde_app');
    if (r.rolsuper) problems.push('is a superuser');
    if (r.rolbypassrls) problems.push('has BYPASSRLS');
    if (r.owns_tables) problems.push('owns the application tables');
    if (!problems.length) return;
    const message = `The database role in DATABASE_URL ${problems.join(', ')}. Connect as a dedicated login role, e.g. CREATE ROLE cde_api LOGIN PASSWORD '...' IN ROLE cde_app;`;
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRIVILEGED_DB_ROLE !== '1') throw new Error(message);
    console.warn(`WARNING: ${message}`);
}

// Graceful shutdown (failure hunt E7). Node's default on SIGTERM is to exit
// at once, cutting off every request in flight, so each deploy or scale-in
// broke uploads and saves in progress. On SIGTERM/SIGINT: report unhealthy
// so the load balancer stops sending traffic, stop accepting connections,
// let in-flight requests finish (up to SHUTDOWN_GRACE_MS, which must be
// shorter than the orchestrator's kill timeout, 30 s by default on
// Kubernetes), then close the database pool.
let draining = false;

function installGracefulShutdown(server) {
    const graceMs = Number(process.env.SHUTDOWN_GRACE_MS || 25_000);
    let started = false;
    const shutdown = (signal) => {
        if (started) return;
        started = true;
        draining = true;
        console.log(`${signal} received: finishing in-flight requests (up to ${graceMs} ms)`);
        const force = setTimeout(() => {
            console.error('Shutdown grace period ended with requests still open; exiting');
            process.exit(1);
        }, graceMs);
        force.unref();
        server.close(async () => {
            await pool.end().catch(() => {});
            console.log('Shutdown complete');
            process.exit(0);
        });
        // Keep-alive connections with no request in progress would otherwise
        // hold server.close() open until they time out.
        server.closeIdleConnections();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
    const port = Number(process.env.PORT || 3000);
    checkDatabaseRole()
        .then(() => {
            const server = createApp().listen(port, () => console.log(`CDE listening on http://localhost:${port}`));
            // Bound slow clients. Large uploads over slow links may need a
            // higher REQUEST_TIMEOUT_MS.
            server.headersTimeout = 30_000;
            server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 15 * 60 * 1000);
            installGracefulShutdown(server);
        })
        .catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { createApp, parseTrustProxy, checkDatabaseRole, installGracefulShutdown };
