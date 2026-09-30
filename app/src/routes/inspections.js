'use strict';

const express = require('express');
const { withTx } = require('../db');
const { HttpError, route, ctx, uuidParam, required, optionalText, UUID_RE } = require('../http');

const router = express.Router();

const TYPES = ['WIR', 'MIR', 'SAFETY', 'QAQC'];
const STATUSES = ['REQUESTED', 'INSPECTED_PASS', 'INSPECTED_FAIL'];

router.get('/projects/:pid/inspections', route(async (req, res) => {
    const pid = uuidParam(req, 'pid');
    const rows = await withTx(ctx(req), async (db) => (await db.query(
        `SELECT i.id, i.inspection_number, i.inspection_type, i.location_description, i.status, i.created_at,
                i.ifc_global_id, i.sheet_revision_id, i.sheet_page, i.sheet_x_norm, i.sheet_y_norm,
                sr.revision_label AS sheet_revision_label, sd.document_number AS sheet_document_number,
                sr.mime_type AS sheet_mime_type, md.document_number AS model_document_number,
                cu.display_name AS created_by_name, au.display_name AS assigned_to_name,
                i.assigned_to = app_current_user_id() AND i.status = 'REQUESTED' AS can_update
           FROM site_inspections i
           LEFT JOIN cde_document_revisions sr ON sr.id = i.sheet_revision_id
           LEFT JOIN cde_documents sd ON sd.id = sr.document_id
           LEFT JOIN cde_document_revisions mr ON mr.id = i.model_revision_id
           LEFT JOIN cde_documents md ON md.id = mr.document_id
           LEFT JOIN users cu ON cu.id = i.created_by
           LEFT JOIN users au ON au.id = i.assigned_to
          WHERE i.project_id = $1
          ORDER BY i.created_at DESC
          LIMIT 500`, [pid])).rows);
    res.json(rows);
}));

router.post('/projects/:pid/inspections', route(async (req, res) => {
    const pid = uuidParam(req, 'pid');
    const b = req.body || {};
    const type = required(b, 'inspection_type');
    if (!TYPES.includes(type)) throw new HttpError(400, 'inspection_type_invalid');
    const assignee = required(b, 'assigned_to');
    if (!UUID_RE.test(assignee)) throw new HttpError(400, 'assignee_required');

    const sheet = b.sheet_revision_id || null;
    if (sheet && !UUID_RE.test(sheet)) throw new HttpError(400, 'sheet_invalid');
    const model = b.model_revision_id || null;
    if (model && !UUID_RE.test(model)) throw new HttpError(400, 'model_invalid');
    const location = optionalText(b, 'location_description', 500);
    const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

    const row = await withTx(ctx(req), async (db) => {
        const n = (await db.query('SELECT next_project_number($1, $2) AS n', [pid, `INSPECTION_${type}`])).rows[0].n;
        return (await db.query(
            `INSERT INTO site_inspections (project_id, inspection_type, inspection_number, location_description,
                    ifc_global_id, model_revision_id, sheet_revision_id, sheet_page, sheet_x_norm, sheet_y_norm,
                    assigned_to)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id, inspection_number`,
            [pid, type, `${type}-${String(n).padStart(4, '0')}`, location,
             b.ifc_global_id || null, model, sheet, sheet ? num(b.sheet_page) ?? 1 : null,
             sheet ? num(b.sheet_x_norm) : null, sheet ? num(b.sheet_y_norm) : null, assignee])).rows[0];
    });
    res.status(201).json(row);
}));

router.patch('/inspections/:id', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const status = required(req.body, 'status');
    if (!STATUSES.includes(status)) throw new HttpError(400, 'status_invalid');
    const n = await withTx(ctx(req), async (db) =>
        (await db.query('UPDATE site_inspections SET status = $2 WHERE id = $1', [id, status])).rowCount);
    if (!n) throw new HttpError(404, 'inspection_update_forbidden');
    res.json({ ok: true });
}));

module.exports = router;
