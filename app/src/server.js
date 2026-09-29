'use strict';

const path = require('node:path');
const express = require('express');
const auth = require('./auth');
const { pool } = require('./db');
const { route, required, errorHandler } = require('./http');

function createApp() {
    const app = express();
    app.disable('x-powered-by');
    // Behind a load balancer, set TRUST_PROXY (e.g. "1") so req.ip is the client's
    // address, which the audit trail records.
    if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

    app.use((req, res, next) => {
        res.set({
            'Content-Security-Policy': [
                "default-src 'self'",
                "style-src 'self' https://fonts.googleapis.com",
                'font-src https://fonts.gstatic.com',
                "img-src 'self' blob: data:",
                "frame-src 'self'",
                "frame-ancestors 'self'",
                "base-uri 'none'",
                "form-action 'self'",
            ].join('; '),
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
        });
        next();
    });

    app.get('/healthz', route(async (_req, res) => {
        await pool.query('SELECT 1');
        res.json({ ok: true });
    }));

    const api = express.Router();
    api.use(express.json({ limit: '1mb' }));

    // CSRF: the session cookie is SameSite=Strict, and every state-changing
    // call must also carry a header a cross-site form cannot set.
    api.use((req, res, next) => {
        if (!['GET', 'HEAD'].includes(req.method) && req.get('X-CDE-Request') !== '1') {
            return res.status(403).json({ error: 'Missing X-CDE-Request header.' });
        }
        next();
    });

    api.post('/auth/login', route(async (req, res) => {
        const email = required(req.body, 'email', 'Email');
        const password = required(req.body, 'password', 'Password');
        const session = await auth.login(email, password, req.ip);
        if (!session) return res.status(401).json({ error: 'Email or password is incorrect.' });
        res.set('Set-Cookie', auth.sessionCookie(session.token, session.maxAge)).json({ ok: true });
    }));

    api.post('/auth/logout', route(async (req, res) => {
        await auth.logout(req);
        res.set('Set-Cookie', auth.sessionCookie('', 0)).json({ ok: true });
    }));

    api.use(auth.requireUser);
    api.use(require('./routes/projects'));
    api.use(require('./routes/documents'));
    api.use(require('./routes/transmittals'));
    api.use(require('./routes/inspections'));
    api.use(require('./routes/audit'));
    api.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

    app.use('/api', api);
    app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
    app.use(errorHandler);
    return app;
}

if (require.main === module) {
    const port = Number(process.env.PORT || 3000);
    createApp().listen(port, () => console.log(`CDE listening on http://localhost:${port}`));
}

module.exports = { createApp };
