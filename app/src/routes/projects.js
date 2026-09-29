'use strict';

const express = require('express');
const { withTx } = require('../db');
const { HttpError, route, ctx, uuidParam } = require('../http');

const router = express.Router();

router.get('/me', route(async (req, res) => {
    const data = await withTx(ctx(req), async (db) => {
        const user = (await db.query(
            `SELECT u.id, u.display_name, u.email, o.legal_name AS organization
               FROM users u LEFT JOIN organizations o ON o.id = u.organization_id
              WHERE u.id = $1`, [req.userId])).rows[0];
        const projects = (await db.query(
            `SELECT p.id, p.code, p.name, m.role
               FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
              ORDER BY p.code`, [req.userId])).rows;
        return { user, projects };
    });
    res.json(data);
}));

router.get('/projects/:pid/meta', route(async (req, res) => {
    const pid = uuidParam(req, 'pid');
    const data = await withTx(ctx(req), async (db) => {
        const project = (await db.query(
            `SELECT id, code, name, app_member_role(id) AS my_role, app_member_org(id) AS my_org_id
               FROM projects WHERE id = $1`, [pid])).rows[0];
        if (!project) throw new HttpError(404, 'Project not found.');
        // Sequential on purpose: one client runs one query at a time.
        const organizations = await db.query(`SELECT o.id, o.legal_name, po.originator_code
                        FROM project_organizations po JOIN organizations o ON o.id = po.organization_id
                       WHERE po.project_id = $1 ORDER BY po.originator_code`, [pid]);
        const members = await db.query(`SELECT u.id, u.display_name, m.organization_id, m.role
                        FROM project_members m JOIN users u ON u.id = m.user_id
                       WHERE m.project_id = $1 AND m.is_active ORDER BY u.display_name`, [pid]);
        const codes = await db.query(`SELECT field, code, description FROM project_code_values
                       WHERE project_id = $1 ORDER BY field, code`, [pid]);
        const suitability = await db.query(`SELECT code, cde_state, revision_prefix, description FROM project_suitability_codes
                       WHERE project_id = $1 ORDER BY cde_state, code`, [pid]);
        return {
            project,
            organizations: organizations.rows,
            members: members.rows,
            codes: codes.rows,
            suitability: suitability.rows,
        };
    });
    res.json(data);
}));

module.exports = router;
