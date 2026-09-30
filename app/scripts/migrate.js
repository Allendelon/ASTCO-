'use strict';
// Applies db/migrations/*.sql in filename order, each in its own transaction,
// and records them in schema_migrations. A changed file that was already
// applied is an error: write a new migration instead.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pool } = require('../src/db');

const dir = path.join(__dirname, '..', '..', 'db', 'migrations');

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
        const { rows } = await client.query('SELECT filename, sha256 FROM schema_migrations');
        const applied = new Map(rows.map((r) => [r.filename, r.sha256]));

        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
            const sql = fs.readFileSync(path.join(dir, file), 'utf8');
            const digest = crypto.createHash('sha256').update(sql).digest('hex');
            if (applied.has(file)) {
                if (applied.get(file) !== digest) throw new Error(`${file} changed after it was applied`);
                continue;
            }
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)', [file, digest]);
                await client.query('COMMIT');
                console.log(`applied ${file}`);
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`${file}: ${err.message}`);
            }
        }
    } finally {
        client.release();
    }
}

if (require.main === module) {
    migrate().then(() => pool.end(), (err) => { console.error(err.message); process.exit(1); });
}

module.exports = { migrate };
