'use strict';
// Bootstraps an administrator account (the only account not created through an invitation).
// Usage: npm run create-admin -- admin@company.com "Full Name"
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('../src/db');
const { hashPassword } = require('../src/auth');

async function main() {
  const [email, fullName] = process.argv.slice(2);
  if (!email || !fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: npm run create-admin -- admin@company.com "Full Name"');
    process.exit(1);
  }
  const db = openDb(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'astco.db'));
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    console.error(`A user with email ${email} already exists.`);
    process.exit(1);
  }
  const password = crypto.randomBytes(12).toString('base64url') + '7a';
  db.prepare("INSERT INTO users (email, password_hash, full_name, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
    .run(email.toLowerCase(), await hashPassword(password), fullName, new Date().toISOString());
  db.close();
  console.log(`Administrator created.\n  Email:    ${email.toLowerCase()}\n  Password: ${password}\nStore this password securely; it is not shown again.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
