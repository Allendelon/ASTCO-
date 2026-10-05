'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { hashPassword, validatePassword } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'astco.db');
// Set COOKIE_SECURE=1 when serving over HTTPS (required in production).
const secureCookies = process.env.COOKIE_SECURE === '1';
// Set TRUST_PROXY=1 when running behind a reverse proxy / PaaS load balancer.
const trustProxy = process.env.TRUST_PROXY === '1';

// On hosts without shell access, the first administrator can be created from
// ADMIN_EMAIL / ADMIN_PASSWORD. Only used while the database has no users at all;
// remove the variables after the first successful start.
async function bootstrapAdmin(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL is not a valid email address.');
  const pwErr = validatePassword(password);
  if (pwErr) throw new Error(`ADMIN_PASSWORD rejected: ${pwErr}`);
  db.prepare("INSERT INTO users (email, password_hash, full_name, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
    .run(email, await hashPassword(password), process.env.ADMIN_NAME || 'Administrator', new Date().toISOString());
  console.log(`Created administrator ${email} from ADMIN_EMAIL. Remove ADMIN_PASSWORD from the environment now.`);
  return true;
}

// In the container we start as root so a root-owned persistent disk can be handed to
// the unprivileged user, then permanently drop root before touching the database.
function dropPrivileges() {
  const target = process.env.DROP_PRIVILEGES_TO;
  if (!target || typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const dir = path.dirname(path.resolve(DB_FILE));
  fs.mkdirSync(dir, { recursive: true });
  const { uid, gid } = fs.statSync(__filename);
  for (const name of ['', ...fs.readdirSync(dir)]) fs.chownSync(path.join(dir, name), uid, gid);
  process.setgid(gid);
  process.setuid(uid);
  console.log(`Running as uid ${process.getuid()} (${target}).`);
}

async function main() {
  dropPrivileges();
  const db = openDb(DB_FILE);
  await bootstrapAdmin(db);
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  const server = http.createServer(createApp(db, { secureCookies, trustProxy }));
  server.listen(PORT, HOST, () => {
    console.log(`ASTCO Procurement & Logistics running on http://localhost:${PORT}`);
    console.log(`Database: ${DB_FILE}`);
    if (userCount === 0) {
      console.log('No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD and restart, or run:\n  npm run create-admin -- you@company.com "Your Name"');
    }
    if (!secureCookies) console.log('Warning: COOKIE_SECURE is not set. Use HTTPS + COOKIE_SECURE=1 in production.');
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
