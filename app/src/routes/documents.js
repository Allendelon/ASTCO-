'use strict';

const express = require('express');
const { withTx } = require('../db');
const storage = require('../storage');
const { HttpError, route, ctx, uuidParam, required } = require('../http');

const router = express.Router();

// Per-user upload volume in any 24 hours, to stop one account filling the disk.
const DAILY_UPLOAD_BYTES = Number(process.env.DAILY_UPLOAD_GB || 20) * 1024 ** 3;

const MAX_PARALLEL_UPLOADS = 4;
const reservations = new Map();   // userId -> { bytes, count } for uploads in progress

function release(userId, bytes) {
    const r = reservations.get(userId);
    if (!r) return;
    r.bytes -= bytes;
    r.count -= 1;
    if (r.count <= 0) reservations.delete(userId);
}

// Browsers may render these inline. Anything else (HTML, SVG, ...) is always
// a download, so an uploaded file can never run script on our origin. The
// stored type for these comes from the file's bytes (see storage.sniff).
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// Next revision after `latest` for a suitability code's state and prefix.
//   WIP:               P01.01 -> P01.02, P01 -> P02.01
//   SHARED/PUBLISHED P: P01.02 -> P01,   P01 -> P02
//   PUBLISHED C:        -> C01, C01 -> C02
function nextRevision(latest, suitability) {
    const { cde_state: state, revision_prefix: prefix } = suitability;
    if (!latest) return state === 'WIP' ? ['P', 1, 1] : [prefix, 1, null];
    if (latest.revision_prefix === 'C') {
        if (prefix !== 'C') {
            throw new HttpError(422, `This document is already at ${latest.revision_label}. New revisions must use a C (contractual) suitability code.`);
        }
        return ['C', latest.revision_major + 1, null];
    }
    if (prefix === 'C') return ['C', 1, null];
    if (state === 'WIP') {
        return latest.revision_minor !== null
            ? ['P', latest.revision_major, latest.revision_minor + 1]
            : ['P', latest.revision_major + 1, 1];
    }
    return latest.revision_minor !== null ? ['P', latest.revision_major, null] : ['P', latest.revision_major + 1, null];
}

router.get('/projects/:pid/documents', route(async (req, res) => {
    const pid = uuidParam(req, 'pid');
    // Escape LIKE wildcards so a search for "_" or "%" means those characters.
    const q = String(req.query.q || '').trim().slice(0, 200).replace(/[\\%_]/g, '\\$&');
    const state = String(req.query.state || '');
    const rows = await withTx(ctx(req), async (db) => (await db.query(
        `SELECT d.id, d.document_number, d.title, d.originator_code, d.volume_code, d.level_code,
                d.type_code, d.role_code, d.number_code, d.created_at,
                r.id AS revision_id, r.revision_label, r.suitability_code, r.cde_state,
                r.created_at AS revised_at, r.mime_type,
                s.id AS shared_revision_id, s.revision_label AS shared_revision_label,
                s.suitability_code AS shared_suitability_code, s.mime_type AS shared_mime_type
           FROM cde_documents d
           LEFT JOIN LATERAL (
                SELECT * FROM cde_document_revisions x
                 WHERE x.document_id = d.id ORDER BY x.revision_seq DESC LIMIT 1) r ON true
           -- Latest revision that has left WIP: what can be transmitted or pinned.
           LEFT JOIN LATERAL (
                SELECT * FROM cde_document_revisions x
                 WHERE x.document_id = d.id AND x.cde_state <> 'WIP' ORDER BY x.revision_seq DESC LIMIT 1) s ON true
          WHERE d.project_id = $1
            AND ($2::text = '' OR d.document_number ILIKE '%' || $2 || '%' OR d.title ILIKE '%' || $2 || '%')
            AND ($3::text = '' OR r.cde_state::text = $3 OR ($3 = 'NONE' AND r.id IS NULL))
          ORDER BY d.document_number
          LIMIT 1000`, [pid, q, state])).rows);
    res.json(rows);
}));

router.post('/projects/:pid/documents', route(async (req, res) => {
    const pid = uuidParam(req, 'pid');
    const b = req.body || {};
    const fields = ['volume_code', 'level_code', 'type_code', 'role_code'].map((f) => required(b, f, f.replace('_code', '')));
    const title = required(b, 'title', 'Title');
    const number = b.number_code ? String(b.number_code).trim() : '';

    const doc = await withTx(ctx(req), async (db) => {
        const me = (await db.query(
            `SELECT p.code AS project_code, po.organization_id, po.originator_code
               FROM projects p JOIN project_organizations po
                 ON po.project_id = p.id AND po.organization_id = app_member_org(p.id)
              WHERE p.id = $1`, [pid])).rows[0];
        if (!me) throw new HttpError(404, 'Project not found.');

        // Next free number within this originator/volume/level/type/role.
        let numberCode = number;
        if (!numberCode) {
            const max = (await db.query(
                `SELECT max(number_code::int) AS n FROM cde_documents
                  WHERE project_id = $1 AND originator_code = $2 AND volume_code = $3
                    AND level_code = $4 AND type_code = $5 AND role_code = $6`,
                [pid, me.originator_code, ...fields])).rows[0].n;
            numberCode = String((max || 0) + 1).padStart(4, '0');
        }
        return (await db.query(
            `INSERT INTO cde_documents (project_id, project_code, originator_org_id, originator_code,
                    volume_code, level_code, type_code, role_code, number_code, title)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, document_number`,
            [pid, me.project_code, me.organization_id, me.originator_code, ...fields, numberCode, title])).rows[0];
    });
    res.status(201).json(doc);
}));

router.get('/documents/:id', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const data = await withTx(ctx(req), async (db) => {
        const doc = (await db.query(
            `SELECT d.*, o.legal_name AS originator_name,
                    d.originator_org_id = app_member_org(d.project_id) AS is_mine,
                    app_member_role(d.project_id) AS my_role
               FROM cde_documents d JOIN organizations o ON o.id = d.originator_org_id
              WHERE d.id = $1`, [id])).rows[0];
        if (!doc) throw new HttpError(404, 'Document not found.');
        const revisions = (await db.query(
            `SELECT r.id, r.revision_label, r.revision_seq, r.suitability_code, r.cde_state, r.mime_type,
                    r.original_filename, r.size_bytes::text AS size_bytes, encode(r.sha256, 'hex') AS sha256,
                    r.created_at, u.display_name AS uploaded_by_name, s.description AS suitability_description
               FROM cde_document_revisions r
               LEFT JOIN users u ON u.id = r.uploaded_by
               LEFT JOIN project_suitability_codes s ON s.project_id = r.project_id AND s.code = r.suitability_code
              WHERE r.document_id = $1 ORDER BY r.revision_seq DESC`, [id])).rows;
        const transmittals = (await db.query(
            `SELECT t.id, t.transmittal_number, t.subject, t.status, t.issued_at, i.revision_id,
                    (SELECT string_agg(x.review_code::text, ', ' ORDER BY x.responded_at)
                       FROM cde_transmittal_responses x
                      WHERE x.transmittal_id = t.id AND x.revision_id = i.revision_id) AS review_codes
               FROM cde_transmittal_items i
               JOIN cde_transmittals t ON t.id = i.transmittal_id
               JOIN cde_document_revisions r ON r.id = i.revision_id
              WHERE r.document_id = $1
              ORDER BY t.created_at DESC`, [id])).rows;
        return { document: doc, revisions, transmittals };
    });
    res.json(data);
}));

router.patch('/documents/:id', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const title = required(req.body, 'title', 'Title');
    const n = await withTx(ctx(req), async (db) =>
        (await db.query('UPDATE cde_documents SET title = $2 WHERE id = $1', [id, title])).rowCount);
    if (!n) throw new HttpError(404, 'Document not found, or you cannot edit it.');
    res.json({ ok: true });
}));

// Raw body upload. The response's object_key is then used to create a revision.
// Raw body upload. The response's object_key is then used to create a
// revision. The database only accepts it from the same person, in the same
// project, once (0008_security_hardening.sql).
router.put('/projects/:pid/uploads', route(async (req, res) => {
    const pid = uuidParam(req, 'pid');
    const { role, used } = await withTx(ctx(req), async (db) => (await db.query(
        `SELECT app_member_role($1) AS role,
                (SELECT coalesce(sum(size_bytes), 0) FROM cde_uploads
                  WHERE uploaded_by = app_current_user_id() AND created_at > now() - interval '24 hours')::text AS used`,
        [pid])).rows[0]);
    if (!role) throw new HttpError(404, 'Project not found.');
    if (role === 'VIEWER') throw new HttpError(403, 'Viewers cannot upload files.');

    // Parallel uploads all read the same "used" figure before any of them
    // finishes, so bytes in flight are reserved per user until the upload
    // is recorded. Without a Content-Length the whole remaining allowance
    // (up to the per-file limit) is reserved.
    const inFlight = reservations.get(req.userId) || { bytes: 0, count: 0 };
    if (inFlight.count >= MAX_PARALLEL_UPLOADS) {
        throw new HttpError(429, `You already have ${MAX_PARALLEL_UPLOADS} uploads in progress. Wait for one to finish.`);
    }
    const remaining = DAILY_UPLOAD_BYTES - Number(used) - inFlight.bytes;
    const declared = Number(req.get('Content-Length') || 0);
    if (remaining <= 0 || declared > remaining) {
        throw new HttpError(429, `You have reached your upload limit of ${DAILY_UPLOAD_BYTES / 1024 ** 3} GB in 24 hours.`);
    }
    if (declared > storage.MAX_BYTES) throw new HttpError(413, `Files can be at most ${storage.MAX_BYTES / 1024 ** 2} MB.`);

    const reserve = Math.min(declared || remaining, remaining, storage.MAX_BYTES);
    inFlight.bytes += reserve;
    inFlight.count += 1;
    reservations.set(req.userId, inFlight);

    let stored;
    try {
        stored = await storage.putStream(req, { maxBytes: reserve });
    } catch (err) {
        release(req.userId, reserve);
        if (err instanceof storage.TooLargeError) throw new HttpError(413, `The ${err.message}.`);
        if (err.message === 'file is empty') throw new HttpError(400, 'The file is empty.');
        throw err;
    }
    const upload = await withTx(ctx(req), async (db) => (await db.query(
        `INSERT INTO cde_uploads (project_id, object_key, size_bytes, detected_mime)
         VALUES ($1, $2, $3, $4) RETURNING id`, [pid, stored.key, stored.size, stored.mime])).rows[0])
        .finally(() => release(req.userId, reserve));
    res.status(201).json({ upload_id: upload.id, object_key: stored.key, size_bytes: stored.size, detected_mime: stored.mime });
}));

router.post('/documents/:id/revisions', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const b = req.body || {};
    const objectKey = required(b, 'object_key', 'Uploaded file');
    const suitabilityCode = required(b, 'suitability_code', 'Suitability');
    const filename = required(b, 'original_filename', 'File name').slice(0, 255);
    const mime = String(b.mime_type || 'application/octet-stream').slice(0, 127);
    if (!storage.KEY_RE.test(objectKey)) throw new HttpError(400, 'Upload the file first.');
    const stat = await storage.stat(objectKey);
    if (!stat) throw new HttpError(400, 'The uploaded file was not found. Upload it again.');

    const revision = await withTx(ctx(req), async (db) => {
        const doc = (await db.query('SELECT id, project_id, originator_org_id FROM cde_documents WHERE id = $1', [id])).rows[0];
        if (!doc) throw new HttpError(404, 'Document not found.');
        const suit = (await db.query(
            'SELECT cde_state, revision_prefix FROM project_suitability_codes WHERE project_id = $1 AND code = $2',
            [doc.project_id, suitabilityCode])).rows[0];
        if (!suit) throw new HttpError(422, `Unknown suitability code ${suitabilityCode}.`);
        const latest = (await db.query(
            `SELECT revision_label, revision_prefix, revision_major, revision_minor FROM cde_document_revisions
              WHERE document_id = $1 ORDER BY revision_seq DESC LIMIT 1`, [id])).rows[0];
        const [prefix, major, minor] = nextRevision(latest, suit);
        return (await db.query(
            `INSERT INTO cde_document_revisions (document_id, project_id, originator_org_id, revision_prefix,
                    revision_major, revision_minor, suitability_code, cde_state, object_key, sha256,
                    size_bytes, mime_type, original_filename)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, decode($9, 'hex'), $10, $11, $12)
             RETURNING id, revision_label`,
            [id, doc.project_id, doc.originator_org_id, prefix, major, minor, suitabilityCode, suit.cde_state,
             objectKey, stat.size, mime, filename])).rows[0];
    });
    res.status(201).json(revision);
}));

// Change suitability in place, e.g. S2 -> S3. The database only lets the
// state move forward and keeps the prefix fixed.
router.patch('/revisions/:id', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const code = required(req.body, 'suitability_code', 'Suitability');
    const row = await withTx(ctx(req), async (db) => (await db.query(
        `UPDATE cde_document_revisions r
            SET suitability_code = s.code, cde_state = s.cde_state
           FROM project_suitability_codes s
          WHERE r.id = $1 AND s.project_id = r.project_id AND s.code = $2
         RETURNING r.id, r.revision_label, r.suitability_code`, [id, code])).rows[0]);
    if (!row) throw new HttpError(404, 'Revision not found, or you cannot change its status. Only document controllers of the originating organisation can.');
    res.json(row);
}));

router.delete('/revisions/:id', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const n = await withTx(ctx(req), async (db) =>
        (await db.query('DELETE FROM cde_document_revisions WHERE id = $1', [id])).rowCount);
    if (!n) throw new HttpError(404, 'Revision not found, or you cannot delete it.');
    res.status(204).end();
}));

router.get('/revisions/:id/file', route(async (req, res) => {
    const id = uuidParam(req, 'id');
    const rev = await withTx(ctx(req), async (db) => {
        const r = (await db.query(
            `SELECT r.id, r.project_id, r.object_key, r.mime_type, r.original_filename, r.revision_label,
                    encode(r.sha256, 'hex') AS sha256, d.document_number
               FROM cde_document_revisions r JOIN cde_documents d ON d.id = r.document_id
              WHERE r.id = $1`, [id])).rows[0];
        if (!r) throw new HttpError(404, 'File not found.');
        // Logged before any bytes leave, in the same transaction as the access check.
        await db.query(`SELECT audit_append($1, 'DOCUMENT_DOWNLOADED', 'REVISION', $2, $3)`,
            [r.project_id, r.id, { revision: r.revision_label, inline: req.query.inline === '1' }]);
        return r;
    });
    const stat = await storage.stat(rev.object_key);
    if (!stat) throw new HttpError(410, 'The stored file is missing. Contact your administrator.');

    const inline = req.query.inline === '1' && INLINE_TYPES.has(rev.mime_type);
    const ext = rev.original_filename.includes('.') ? rev.original_filename.slice(rev.original_filename.lastIndexOf('.')) : '';
    const name = `${rev.document_number}_${rev.revision_label}${ext}`;
    res.set({
        'Content-Type': inline ? rev.mime_type : 'application/octet-stream',
        'Content-Length': String(stat.size),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        // Chrome's PDF viewer refuses to run in a sandboxed document; PDFs and
        // the allowed image types cannot execute script on this origin anyway.
        ...(inline && rev.mime_type === 'application/pdf' ? {} : { 'Content-Security-Policy': 'sandbox' }),
        'X-Content-SHA256': rev.sha256,
        'Cache-Control': 'private, no-store',
    });
    storage.createReadStream(rev.object_key).on('error', (err) => res.destroy(err)).pipe(res);
}));

module.exports = router;
module.exports.nextRevision = nextRevision;
