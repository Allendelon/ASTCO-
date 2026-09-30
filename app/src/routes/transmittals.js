'use strict';

const express = require('express');
const { withTx } = require('../db');
const { HttpError, route, ctx, uuidParam, required, optionalText, UUID_RE } = require('../http');

const router = express.Router();

const REASONS = ['FOR_APPROVAL', 'FOR_REVIEW', 'FOR_INFORMATION', 'FOR_CONSTRUCTION', 'FOR_TENDER', 'AS_BUILT'];
const CODES = ['CODE_A', 'CODE_B', 'CODE_C', 'CODE_D'];

// Each id becomes an INSERT inside one transaction; cap the counts so a
// single request cannot hold a connection and locks for minutes.
const MAX_ITEMS = 500;
const MAX_RECIPIENTS = 200;

const uuidList = (value, label, max) => {
    const list = Array.isArray(value) ? value : [];
    if (list.length > max) throw new HttpError(400, `${label} can have at most ${max} entries.`);
    if (!list.every((v) => UUID_RE.test(v))) throw new HttpError(400, `${label} contains an invalid id.`);
    return [...new Set(list)];
};

router.get('/projects/:pid/transmittals', route(async (req, res) => {
    const pid = uuidParam(req, 'pid');
    const box = ['inbox', 'sent'].includes(req.query.box) ? req.query.box : 'all';
    const rows = await withTx(ctx(req), async (db) => (await db.query(
        `SELECT t.id, t.transmittal_number, t.subject, t.reason_for_issue, t.status, t.issued_at,
                t.sla_due_date::text AS sla_due_date, t.created_at, so.legal_name AS sender_name,
                (SELECT count(*)::int FROM cde_transmittal_items i WHERE i.transmittal_id = t.id) AS item_count,
                (SELECT count(*)::int FROM cde_transmittal_responses x WHERE x.transmittal_id = t.id) AS response_count,
                t.status IN ('ISSUED', 'UNDER_REVIEW') AND t.sla_due_date < current_date AS overdue,
                t.sender_org_id = app_member_org(t.project_id) AS is_sent
           FROM cde_transmittals t JOIN organizations so ON so.id = t.sender_org_id
          WHERE t.project_id = $1
            AND ($2 = 'all'
                 OR ($2 = 'sent' AND t.sender_org_id = app_member_org(t.project_id))
                 OR ($2 = 'inbox' AND t.status <> 'DRAFT' AND EXISTS (
                        SELECT 1 FROM cde_transmittal_recipients r
                         WHERE r.transmittal_id = t.id AND r.organization_id = app_member_org(t.project_id))))
          ORDER BY coalesce(t.issued_at, t.created_at) DESC
          LIMIT 500`, [pid, box])).rows);
    res.json(rows);
}));

router.post('/projects/:pid/transmittals', route(async (req, res) => {
    const pid = uuidParam(req, 'pid');
    const b = req.body || {};
    const subject = required(b, 'subject', 'Subject');
    const message = optionalText(b, 'message', 'The message', 20_000);
    const reason = required(b, 'reason_for_issue', 'Reason for issue');
    if (!REASONS.includes(reason)) throw new HttpError(400, 'Choose a valid reason for issue.');
    const due = b.sla_due_date ? String(b.sla_due_date) : null;
    const revisionIds = uuidList(b.revision_ids, 'Documents', MAX_ITEMS);
    const to = uuidList(b.to, 'To', MAX_RECIPIENTS);
    const cc = uuidList(b.cc, 'Cc', MAX_RECIPIENTS).filter((id) => !to.includes(id));

    const created = await withTx(ctx(req), async (db) => {
        const me = (await db.query(
            `SELECT po.organization_id, po.originator_code FROM project_organizations po
              WHERE po.project_id = $1 AND po.organization_id = app_member_org($1)`, [pid])).rows[0];
        if (!me) throw new HttpError(404, 'Project not found.');
        const n = (await db.query('SELECT next_project_number($1, $2) AS n', [pid, 'TRANSMITTAL'])).rows[0].n;
        const number = `TR-${me.originator_code}-${String(n).padStart(5, '0')}`;
        const t = (await db.query(
            `INSERT INTO cde_transmittals (project_id, transmittal_number, sender_org_id, subject, message,
                    reason_for_issue, sla_due_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, transmittal_number`,
            [pid, number, me.organization_id, subject, message, reason, due])).rows[0];
        for (const rid of revisionIds) {
            await db.query('INSERT INTO cde_transmittal_items (transmittal_id, project_id, revision_id) VALUES ($1, $2, $3)',
                [t.id, pid, rid]);
        }
        for (const [kind, users] of [['TO', to], ['CC', cc]]) {
            for (const uid of users) {
                const r = await db.query(
                    `INSERT INTO cde_transmittal_recipients (transmittal_id, project_id, user_id, organization_id, kind)
                     SELECT $1, $2, m.user_id, m.organization_id, $4
                       FROM project_members m WHERE m.project_id = $2 AND m.user_id = $3 AND m.is_active`,
                    [t.id, pid, uid, kind]);
                if (!r.rowCount) throw new HttpError(422, 'A recipient is not an active member of this project.');
            }
        }
        if (b.issue) await db.query(`UPDATE cde_transmittals SET status = 'ISSUED' WHERE id = $1`, [t.id]);
        return t;
    });
    res.status(201).json(created);
}));

router.get('/transmittals/:id', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const data = await withTx(ctx(req), async (db) => {
        const t = (await db.query(
            `SELECT t.id, t.project_id, t.transmittal_number, t.subject, t.message, t.reason_for_issue, t.status,
                    t.sla_due_date::text AS sla_due_date, t.issued_at, t.created_at,
                    so.legal_name AS sender_name, cu.display_name AS created_by_name,
                    t.sender_org_id = app_member_org(t.project_id) AS is_sender,
                    app_member_role(t.project_id) AS my_role, app_member_org(t.project_id) AS my_org_id
               FROM cde_transmittals t
               JOIN organizations so ON so.id = t.sender_org_id
               LEFT JOIN users cu ON cu.id = t.created_by
              WHERE t.id = $1`, [id])).rows[0];
        if (!t) throw new HttpError(404, 'Transmittal not found.');
        const recipients = (await db.query(
            `SELECT r.user_id, r.kind, r.organization_id, u.display_name, o.legal_name AS organization
               FROM cde_transmittal_recipients r
               LEFT JOIN users u ON u.id = r.user_id
               LEFT JOIN organizations o ON o.id = r.organization_id
              WHERE r.transmittal_id = $1 ORDER BY r.kind DESC, u.display_name`, [id])).rows;
        const items = (await db.query(
            `SELECT i.revision_id, r.revision_label, r.suitability_code, r.cde_state, r.mime_type,
                    d.id AS document_id, d.document_number, d.title
               FROM cde_transmittal_items i
               JOIN cde_document_revisions r ON r.id = i.revision_id
               JOIN cde_documents d ON d.id = r.document_id
              WHERE i.transmittal_id = $1 ORDER BY d.document_number`, [id])).rows;
        const responses = (await db.query(
            `SELECT x.revision_id, x.review_code, x.comments, x.responded_at, x.responder_org_id,
                    o.legal_name AS organization, u.display_name AS responded_by_name
               FROM cde_transmittal_responses x
               LEFT JOIN organizations o ON o.id = x.responder_org_id
               LEFT JOIN users u ON u.id = x.responded_by
              WHERE x.transmittal_id = $1 ORDER BY x.responded_at`, [id])).rows;

        const openForReview = ['ISSUED', 'UNDER_REVIEW'].includes(t.status);
        const iAmTo = recipients.some((r) => r.kind === 'TO' && r.organization_id === t.my_org_id);
        const answered = new Set(responses.filter((x) => x.responder_org_id === t.my_org_id).map((x) => x.revision_id));
        const canAct = t.my_role !== 'VIEWER';
        return {
            transmittal: t,
            recipients,
            items,
            responses,
            can: {
                edit: t.is_sender && t.status === 'DRAFT' && canAct,
                issue: t.is_sender && t.status === 'DRAFT' && canAct,
                close: t.is_sender && openForReview && canAct,
                respond: iAmTo && openForReview && canAct && items.some((i) => !answered.has(i.revision_id)),
            },
            answered: [...answered],
        };
    });
    res.json(data);
}));

router.post('/transmittals/:id/issue', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const n = await withTx(ctx(req), async (db) =>
        (await db.query(`UPDATE cde_transmittals SET status = 'ISSUED' WHERE id = $1 AND status = 'DRAFT'`, [id])).rowCount);
    if (!n) throw new HttpError(404, 'Draft transmittal not found, or you cannot issue it.');
    res.json({ ok: true });
}));

router.post('/transmittals/:id/close', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const n = await withTx(ctx(req), async (db) =>
        (await db.query(`UPDATE cde_transmittals SET status = 'CLOSED'
                          WHERE id = $1 AND status IN ('ISSUED', 'UNDER_REVIEW')`, [id])).rowCount);
    if (!n) throw new HttpError(404, 'Open transmittal not found, or you cannot close it.');
    res.json({ ok: true });
}));

router.delete('/transmittals/:id', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const n = await withTx(ctx(req), async (db) =>
        (await db.query(`DELETE FROM cde_transmittals WHERE id = $1`, [id])).rowCount);
    if (!n) throw new HttpError(404, 'Transmittal not found, or you cannot delete it.');
    res.status(204).end();
}));

router.post('/transmittals/:id/responses', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const list = Array.isArray(req.body?.responses) ? req.body.responses : [];
    if (!list.length) throw new HttpError(400, 'Add a review code to at least one document.');
    if (list.length > MAX_ITEMS) throw new HttpError(400, `A review can cover at most ${MAX_ITEMS} documents.`);
    for (const r of list) {
        if (!UUID_RE.test(r.revision_id || '')) throw new HttpError(400, 'Invalid document in the review.');
        if (!CODES.includes(r.review_code)) throw new HttpError(400, 'Choose a review code for every document.');
        r.comments = optionalText(r, 'comments', 'A review comment', 10_000);
    }
    await withTx(ctx(req), async (db) => {
        const t = (await db.query('SELECT project_id, app_member_org(project_id) AS org FROM cde_transmittals WHERE id = $1', [id])).rows[0];
        if (!t) throw new HttpError(404, 'Transmittal not found.');
        for (const r of list) {
            await db.query(
                `INSERT INTO cde_transmittal_responses (transmittal_id, revision_id, project_id, responder_org_id,
                        review_code, comments)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [id, r.revision_id, t.project_id, t.org, r.review_code, r.comments]);
        }
    });
    res.status(201).json({ ok: true });
}));

module.exports = router;
