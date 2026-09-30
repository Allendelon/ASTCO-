'use strict';

const { Pool } = require('pg');

// Timeouts, in milliseconds. Without them one blocked lock or an unreachable
// database makes every request wait forever: the pool's connections fill up
// and even endpoints that touch other tables hang (failure hunt E1).
const TIMEOUTS = {
    // Wait for a pooled connection (or to open one) before failing the request.
    connect: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5_000),
    // Longest single statement. Audit verification of a very long chain is
    // the slowest legitimate query; raise this if yours needs longer.
    statement: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 15_000),
    // Longest wait for a row or table lock held by someone else.
    lock: Number(process.env.DB_LOCK_TIMEOUT_MS || 5_000),
    // A transaction left open with no statement running (a bug, or a stuck
    // client) is ended by the server instead of holding locks.
    idleInTransaction: Number(process.env.DB_IDLE_TX_TIMEOUT_MS || 60_000),
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/cde',
    max: Number(process.env.PG_POOL_MAX || 10),
    connectionTimeoutMillis: TIMEOUTS.connect,
});

// An idle pooled connection that errors (database restart, failover, a
// network drop) makes the pool emit 'error'. With no listener Node treats
// that as an unhandled error and the whole process exits. Log it instead;
// the pool drops that client and opens a new one on the next request.
pool.on('error', (err) => {
    console.error(`database connection error (idle client discarded): ${err.message}`);
});

// Runs fn(client) in one transaction as the RLS-restricted cde_app role, with
// the request context the policies and audit chain read. SET LOCAL and
// set_config(..., true) are transaction-scoped, so nothing leaks to the next
// user of the pooled connection.
async function withTx(ctx, fn) {
    const client = await pool.connect();

    // pg-pool removes its own 'error' listener from a client while it is
    // checked out (pg-pool/index.js, _acquireClient) and re-adds it on
    // release. If the connection dies mid-transaction (failover,
    // pg_terminate_backend, network drop) the client emits 'error'; with no
    // listener, Node exits the whole process (failure hunt E3). The query in
    // progress rejects on its own; this listener only records the failure so
    // the dead client is destroyed on release instead of being reused.
    let connectionError = null;
    const onError = (err) => { connectionError = err; };
    client.on('error', onError);

    try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE cde_app');
        await client.query(
            `SELECT set_config('app.user_id', $1, true), set_config('app.client_ip', $2, true),
                    set_config('statement_timeout', $3, true), set_config('lock_timeout', $4, true),
                    set_config('idle_in_transaction_session_timeout', $5, true)`,
            [ctx.userId || '', ctx.ip || '', String(TIMEOUTS.statement), String(TIMEOUTS.lock),
             String(TIMEOUTS.idleInTransaction)]
        );
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        if (!connectionError) await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.removeListener('error', onError);
        // A truthy argument tells pg-pool to destroy the client, not reuse it.
        client.release(connectionError || undefined);
    }
}

module.exports = { pool, withTx, TIMEOUTS };
