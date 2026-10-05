'use strict';
const http = require('node:http');
const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'astco.db');
// Set COOKIE_SECURE=1 when serving over HTTPS (required in production).
const secureCookies = process.env.COOKIE_SECURE === '1';

const db = openDb(DB_FILE);
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

const server = http.createServer(createApp(db, { secureCookies }));
server.listen(PORT, HOST, () => {
  console.log(`ASTCO Procurement & Logistics running on http://localhost:${PORT}`);
  console.log(`Database: ${DB_FILE}`);
  if (userCount === 0) {
    console.log('No users yet. Create the first administrator with:\n  npm run create-admin -- you@company.com "Your Name"');
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
