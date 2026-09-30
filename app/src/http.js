'use strict';

const { renderEnglish } = require('./i18n');

// Errors carry a stable code and parameters (ADR-006). The browser renders
// the code in the user's language; `message` is the English rendering, sent
// as `error` for API clients and logs. Codes live in public/i18n/*.json
// under "err.<code>"; test/i18n.test.js checks every code used here exists.
class HttpError extends Error {
    constructor(status, code, params = {}) {
        super(renderEnglish(`err.${code}`, params));
        this.status = status;
        this.code = code;
        this.params = params;
    }
}

// Express 4 does not catch rejected promises from handlers.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ctx = (req) => ({ userId: req.userId, ip: req.ip });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(req, name) {
    const value = req.params[name];
    if (!UUID_RE.test(value)) throw new HttpError(404, 'not_found');
    return value;
}

// `field` doubles as the catalog key for its label ("field.<field>").
function required(body, field) {
    const value = body?.[field];
    if (value === undefined || value === null || String(value).trim() === '') {
        throw new HttpError(400, 'field_required', { field });
    }
    return typeof value === 'string' ? value.trim() : value;
}

// Optional free text with an upper bound, so one request cannot store
// megabytes in a field shown on every page that lists it.
function optionalText(body, field, max) {
    const value = body?.[field];
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (text.length > max) throw new HttpError(400, 'text_too_long', { field, max });
    return text || null;
}

// CHECK constraints (names as Postgres generated them in db/migrations).
const CHECK_CODES = {
    cde_transmittal_responses_check: 'check_review_comment',
    cde_transmittals_check1: 'check_due_date',
    cde_document_revisions_check: 'check_wip_minor',
    cde_documents_number_code_check: 'check_doc_number',
    cde_documents_title_check: 'check_title',
    cde_transmittals_subject_check: 'check_subject',
    site_inspections_check: 'check_ifc_model_pair',
    site_inspections_check1: 'check_sheet_pin',
    site_inspections_ifc_global_id_check: 'check_ifc_format',
    site_inspections_sheet_x_norm_check: 'check_pin_on_sheet',
    site_inspections_sheet_y_norm_check: 'check_pin_on_sheet',
    cde_document_revisions_revision_major_check: 'check_revision_major',
    cde_document_revisions_revision_minor_check: 'check_revision_minor',
};

const UNIQUE_CODES = {
    cde_documents: 'duplicate_document',
    cde_document_revisions: 'duplicate_revision',
    cde_transmittal_items: 'duplicate_item',
    cde_transmittal_recipients: 'duplicate_recipient',
    cde_transmittal_responses: 'duplicate_response',
};

// Messages raised by the schema's own triggers and functions, mapped to
// codes. test/i18n.test.js parses every RAISE EXCEPTION in db/migrations
// and fails if one is missing here, so a new database rule cannot reach
// users untranslated.
const DB_ERRORS = [
    [/^CDE state cannot move backwards \((\S+) -> (\S+)\)/, 'state_backwards', ['from', 'to']],
    [/^WIP revisions cannot be transmitted/, 'wip_not_transmittable'],
    [/^a draft transmittal can only move to ISSUED/, 'draft_only_to_issued'],
    [/^a new inspection starts as REQUESTED/, 'inspection_starts_requested'],
    [/^audit_append: current user is not a member/, 'membership_required'],
    [/^not a member of project/, 'membership_required'],
    [/^audit_append: no user in the request context/, 'forbidden'],
    [/^audit_trail is append-only/, 'forbidden'],
    [/^cannot move \S+ rows between transmittals/, 'transmittal_locked'],
    [/^daily upload limit reached/, 'upload_quota'],
    [/^too many uploads in progress/, 'upload_parallel'],
    [/^document identity is immutable/, 'document_identity_immutable'],
    [/^inspection (\S+) already has a result \((\S+)\)/, 'inspection_result_final', ['number', 'status']],
    [/^inspections can only be pinned to shared or published revisions/, 'inspection_pin_wip'],
    [/^only TO recipients can respond/, 'only_to_recipients'],
    [/^only project admins and document controllers can verify/, 'audit_verify_forbidden'],
    [/^only the result of an inspection can be recorded/, 'inspection_only_result'],
    [/^revision (\S+) is (\S+) and cannot be deleted/, 'revision_not_deletable', ['revision', 'state']],
    [/^revision (\S+) must come after the latest revision (\S+)/, 'revision_order', ['revision', 'latest']],
    [/^revision content is immutable/, 'revision_immutable'],
    [/^transmittal (\S+) has been issued and cannot be deleted/, 'transmittal_not_deletable', ['number']],
    [/^transmittal (\S+) has been issued and is immutable/, 'transmittal_immutable', ['number']],
    [/^transmittal (\S+) has no TO recipient/, 'transmittal_no_to', ['number']],
    [/^transmittal (\S+) has no items/, 'transmittal_no_items', ['number']],
    [/^transmittal has been issued; \S+ on \S+ rejected/, 'transmittal_locked'],
    [/^transmittal is (\S+) and does not accept responses/, 'transmittal_closed_responses', ['status']],
    [/^transmittal responses are append-only/, 'responses_append_only'],
    [/^transmittal status cannot move backwards \((\S+) -> (\S+)\)/, 'transmittal_status_backwards', ['from', 'to']],
    [/^upload the file again before creating this revision/, 'upload_again'],
    [/^you cannot upload files to this project/, 'upload_forbidden'],
];

function fromDbMessage(status, message) {
    for (const [re, code, names = []] of DB_ERRORS) {
        const m = re.exec(message);
        if (m) return new HttpError(status, code, Object.fromEntries(names.map((n, i) => [n, m[i + 1]])));
    }
    return null;
}

// Postgres errors carry the rule that was broken; map each to a code.
function fromPgError(err) {
    switch (err.code) {
        // err.detail repeats key values and names tables, and can confirm
        // that rows the caller cannot see exist. Never send it to clients.
        case '23505':
            return new HttpError(409, UNIQUE_CODES[err.table] || 'duplicate');
        case '23503':
            return new HttpError(422, 'invalid_reference');
        case '23514':
            return CHECK_CODES[err.constraint]
                ? new HttpError(422, CHECK_CODES[err.constraint])
                : new HttpError(422, 'rule_violated', { rule: err.constraint });
        case '23502':
            return new HttpError(400, 'missing_value', { field: err.column });
        case '23000':
            return fromDbMessage(422, err.message) || new HttpError(422, 'rule_violated', { rule: err.message });
        case '42501':
            if (/row-level security|permission denied/.test(err.message)) return new HttpError(403, 'forbidden');
            return fromDbMessage(403, err.message) || new HttpError(403, 'forbidden');
        case '22P02':
        case '22007':
        case '22008':
            return new HttpError(400, 'invalid_value', { detail: err.message });
        default:
            return null;
    }
}

// The database is busy or unreachable: the request may succeed if retried.
// 57014 statement timeout, 55P03 lock timeout, 57P01-57P03 server shutting
// down or starting, 08xxx connection failures, and pg-pool's own messages.
function isUnavailable(err) {
    return ['57014', '55P03', '57P01', '57P02', '57P03'].includes(err.code)
        || /^08/.test(err.code || '')
        // Only socket errors from connecting to the database: ENOENT from the
        // file store (a missing stored file) is not "unavailable".
        || (err.syscall === 'connect' && ['ECONNREFUSED', 'ENOENT', 'ETIMEDOUT'].includes(err.code))
        || /timeout exceeded when trying to connect|Connection terminated/.test(err.message || '');
}

function sendError(res, e) {
    return res.status(e.status).json({ error: e.message, code: e.code, params: e.params });
}

function errorHandler(err, req, res, _next) {
    const mapped = err instanceof HttpError ? err : fromPgError(err);
    if (mapped) return sendError(res, mapped);
    if (err.type === 'entity.parse.failed') return sendError(res, new HttpError(400, 'invalid_json'));
    if (isUnavailable(err)) {
        // Expected during database restarts, failovers and lock contention:
        // one line per request, not a stack trace.
        console.warn(`503 ${req.method} ${req.originalUrl}: ${err.code || ''} ${err.message}`);
        res.set('Retry-After', '5');
        return sendError(res, new HttpError(503, 'service_unavailable'));
    }
    console.error(err);
    sendError(res, new HttpError(500, 'server_error'));
}

module.exports = {
    HttpError, route, ctx, uuidParam, required, optionalText, errorHandler, sendError, isUnavailable, UUID_RE, DB_ERRORS,
};
