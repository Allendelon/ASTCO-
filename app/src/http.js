'use strict';

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// Express 4 does not catch rejected promises from handlers.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ctx = (req) => ({ userId: req.userId, ip: req.ip });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(req, name) {
    const value = req.params[name];
    if (!UUID_RE.test(value)) throw new HttpError(404, 'Not found.');
    return value;
}

function required(body, field, label = field) {
    const value = body?.[field];
    if (value === undefined || value === null || String(value).trim() === '') {
        throw new HttpError(400, `${label} is required.`);
    }
    return typeof value === 'string' ? value.trim() : value;
}

// Plain-language messages for the schema's CHECK constraints (names as
// Postgres generated them in db/migrations).
const CHECK_MESSAGES = {
    cde_transmittal_responses_check: 'Codes C and D return the document, so add a comment saying what must change.',
    cde_transmittals_check1: 'Transmittals for approval or review need a response due date.',
    cde_document_revisions_check: 'Work-in-progress versions (such as P01.02) cannot be shared. Upload the file as a new shared revision.',
    cde_documents_number_code_check: 'The document number must be 4 to 6 digits.',
    cde_documents_title_check: 'The title must be 1 to 255 characters.',
    cde_transmittals_subject_check: 'The subject must be 1 to 255 characters.',
    site_inspections_check: 'An IFC GlobalId needs the model it belongs to, and the other way round.',
    site_inspections_check1: 'A sheet pin needs the sheet, the page and both coordinates.',
    site_inspections_ifc_global_id_check: 'An IFC GlobalId is 22 characters and starts with 0–3.',
    site_inspections_sheet_x_norm_check: 'The pin must be on the sheet.',
    site_inspections_sheet_y_norm_check: 'The pin must be on the sheet.',
};

// Postgres errors carry the rule that was broken. The schema's own messages
// are written for people, so pass those through; translate the generic ones.
function fromPgError(err) {
    switch (err.code) {
        case '23505':
            return new HttpError(409, `That already exists. ${err.detail || ''}`.trim());
        case '23503':
            return new HttpError(422, `A referenced value is not valid for this project. ${err.detail || ''}`.trim());
        case '23514':
            return new HttpError(422, CHECK_MESSAGES[err.constraint] || `The data breaks the rule "${err.constraint}".`);
        case '23502':
            return new HttpError(400, `${err.column} is required.`);
        case '23000':
            return new HttpError(422, err.message);
        case '42501':
            return new HttpError(403, /row-level security|permission denied/.test(err.message)
                ? "You don't have permission to do that." : err.message);
        case '22P02':
        case '22007':
        case '22008':
            return new HttpError(400, `Invalid value: ${err.message}`);
        default:
            return null;
    }
}

function errorHandler(err, req, res, _next) {
    const mapped = err instanceof HttpError ? err : fromPgError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server. The error has been logged.' });
}

module.exports = { HttpError, route, ctx, uuidParam, required, errorHandler, UUID_RE };
