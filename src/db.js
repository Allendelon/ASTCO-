'use strict';
// SQLite persistence using Node's built-in node:sqlite (Node >= 22.13).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vendors (
  id            INTEGER PRIMARY KEY,
  company_name  TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  country       TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','procurement_manager','procurement_staff','vendor')),
  vendor_id     INTEGER REFERENCES vendors(id),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  CHECK ((role = 'vendor') = (vendor_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Generic, extensible vendor taxonomy: kind = discipline | product_type | service | ...
CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (kind, name)
);

CREATE TABLE IF NOT EXISTS vendor_categories (
  vendor_id   INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (vendor_id, category_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL COLLATE NOCASE,
  role         TEXT NOT NULL CHECK (role IN ('admin','procurement_manager','procurement_staff','vendor')),
  company_name TEXT NOT NULL DEFAULT '',
  vendor_id    INTEGER REFERENCES vendors(id),
  category_ids TEXT NOT NULL DEFAULT '[]',
  invited_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY,
  vendor_id      INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  sku            TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  category_id    INTEGER REFERENCES categories(id),
  unit           TEXT NOT NULL DEFAULT 'EA',
  unit_price     REAL NOT NULL CHECK (unit_price >= 0),
  currency       TEXT NOT NULL DEFAULT 'USD',
  lead_time_days INTEGER NOT NULL DEFAULT 0 CHECK (lead_time_days >= 0),
  moq            INTEGER NOT NULL DEFAULT 1 CHECK (moq >= 1),
  active         INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_vendor ON products(vendor_id);

CREATE TABLE IF NOT EXISTS rfqs (
  id               INTEGER PRIMARY KEY,
  ref              TEXT UNIQUE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  quantity         REAL NOT NULL CHECK (quantity > 0),
  unit             TEXT NOT NULL DEFAULT 'EA',
  required_by      TEXT,
  delivery_location TEXT NOT NULL DEFAULT '',
  closes_at        TEXT NOT NULL,
  sealed           INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','awarded','cancelled')),
  awarded_quote_id INTEGER,
  created_by       INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rfq_categories (
  rfq_id      INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  PRIMARY KEY (rfq_id, category_id)
);

CREATE TABLE IF NOT EXISTS rfq_recipients (
  rfq_id      INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  vendor_id   INTEGER NOT NULL REFERENCES vendors(id),
  sent_at     TEXT NOT NULL,
  viewed_at   TEXT,
  declined_at TEXT,
  decline_reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (rfq_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS quotes (
  id             INTEGER PRIMARY KEY,
  rfq_id         INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  vendor_id      INTEGER NOT NULL REFERENCES vendors(id),
  unit_price     REAL NOT NULL CHECK (unit_price >= 0),
  total_price    REAL NOT NULL CHECK (total_price >= 0),
  currency       TEXT NOT NULL DEFAULT 'USD',
  lead_time_days INTEGER NOT NULL CHECK (lead_time_days >= 0),
  valid_until    TEXT,
  incoterm       TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','awarded','not_awarded')),
  submitted_at   TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (rfq_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER,
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id INTEGER,
  detail    TEXT NOT NULL DEFAULT '',
  at        TEXT NOT NULL
);
`;

const DEFAULT_CATEGORIES = {
  discipline: ['Piping', 'Mechanical', 'Electrical', 'Instrumentation & Control', 'Civil & Structural', 'HVAC', 'Telecom', 'Safety & Fire Protection'],
  product_type: ['Valves', 'Pipes & Fittings', 'Flanges & Gaskets', 'Pumps', 'Compressors', 'Heat Exchangers', 'Switchgear & Panels', 'Cables & Wiring', 'Transmitters & Sensors', 'Structural Steel', 'Fasteners & Bolting', 'Consumables & PPE', 'Spare Parts'],
  service: ['Fabrication', 'Calibration & Testing', 'Freight Forwarding', 'Customs Brokerage', 'Heavy Haulage', 'Third-Party Inspection'],
};

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO categories (kind, name) VALUES (?, ?)');
    for (const [kind, names] of Object.entries(DEFAULT_CATEGORIES)) {
      for (const name of names) ins.run(kind, name);
    }
  }
  return db;
}

// Runs fn inside a transaction; rolls back on throw.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx };
