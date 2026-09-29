'use strict';

const express = require('express');
const { withTx } = require('../db');
const { HttpError, route, ctx, uuidParam } = require('../http');

const router = express.Router();

router.get('/projects/:pid/audit', route(async (req, res) => {
    const pid = uuidParam(req, 'pid');
    const before = /^\d+$/.test(req.query.before || '') ? req.query.before : null;
    const rows = await withTx(ctx(req), async (db) => {
        const role = (await db.query('SELECT app_member_role($1) AS role', [pid])).rows[0].role;
        if (!['ADMIN', 'DOC_CONTROLLER'].includes(role)) {
            throw new HttpError(403, 'Only project admins and document controllers can view the audit trail.');
        }
        return (await db.query(
            `SELECT a.chain_seq::text AS chain_seq, a.action, a.resource_type, a.resource_id, a.details,
                    a.event_timestamp, host(a.actor_ip) AS actor_ip, u.display_name AS actor_name,
                    encode(a.current_hash, 'hex') AS current_hash
               FROM audit_trail a LEFT JOIN users u ON u.id = a.actor_id
              WHERE a.project_id = $1 AND ($2::bigint IS NULL OR a.chain_seq < $2::bigint)
              ORDER BY a.chain_seq DESC
              LIMIT 200`, [pid, before])).rows;
    });
    res.json(rows);
}));

router.post('/projects/:pid/audit/verify', route(async (req, res) => {
    const pid = uuidParam(req, 'pid');
    const broken = await withTx(ctx(req), async (db) =>
        (await db.query('SELECT audit_verify_project($1)::text AS broken', [pid])).rows[0].broken);
    res.json({ intact: broken === null, first_broken_seq: broken });
}));

module.exports = router;
