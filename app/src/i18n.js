'use strict';
// Server side of i18n (ADR-006). The API speaks in stable error codes plus
// parameters; the browser renders them in the user's language from the same
// catalogs (public/i18n/*.json). The server renders English only, for the
// `error` field that API clients and logs read.

const path = require('node:path');

const en = require(path.join(__dirname, '..', 'public', 'i18n', 'en.json'));

// Parameter values that are themselves catalog entries: field names and
// enum values (CDE states, transmittal and inspection statuses).
function labelParam(name, value) {
    if (name === 'field') return en[`field.${value}`] ?? value;
    for (const prefix of ['state', 'tstatus', 'istatus']) {
        const label = en[`${prefix}.${value}`];
        if (label !== undefined) return label;
    }
    return value;
}

function renderEnglish(key, params = {}) {
    const template = en[key];
    if (template === undefined) return key;
    return template.replace(/\{(\w+)\}/g, (m, name) =>
        (params[name] === undefined ? m : String(labelParam(name, params[name]))));
}

module.exports = { renderEnglish, catalog: en };
