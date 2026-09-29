'use strict';

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/cde',
    max: Number(process.env.PG_POOL_MAX || 10),
});

// Runs fn(client) in one transaction as the RLS-restricted cde_app role, with
// the request context the policies and audit chain read. SET LOCAL and
// set_config(..., true) are transaction-scoped, so nothing leaks to the next
// user of the pooled connection.
async function withTx(ctx, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE cde_app');
        await client.query(
            "SELECT set_config('app.user_id', $1, true), set_config('app.client_ip', $2, true)",
            [ctx.userId || '', ctx.ip || '']
        );
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { pool, withTx };
