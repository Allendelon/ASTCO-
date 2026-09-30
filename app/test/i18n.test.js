'use strict';
// Keeps the two languages complete and in step (ADR-006). No database needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const en = require('../public/i18n/en.json');
const ar = require('../public/i18n/ar.json');
const read = (p) => fs.readFileSync(p, 'utf8');
const filesIn = (dir, ext) => fs.readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
// Arabic plural forms may leave the number implicit ("وثيقتان" = two documents).
const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;

test('English and Arabic have the same keys', () => {
    const missingAr = Object.keys(en).filter((k) => !(k in ar));
    const extraAr = Object.keys(ar).filter((k) => !(k in en));
    assert.deepEqual(missingAr, [], 'keys missing from ar.json');
    assert.deepEqual(extraAr, [], 'keys only in ar.json');
});

test('every placeholder in English exists in Arabic, and the other way round', () => {
    for (const key of Object.keys(en)) {
        if (PLURAL_SUFFIX.test(key)) continue;
        assert.deepEqual(placeholders(ar[key]), placeholders(en[key]), `placeholders differ for ${key}`);
    }
});

test('every error code and field the server uses has a catalog entry', () => {
    const src = filesIn(path.join(root, 'src'), '.js').map(read).join('\n');
    const codes = [...src.matchAll(/new (?:Http|Login)Error\(\s*\d+,\s*'([a-z_0-9]+)'/g)].map((m) => m[1]);
    const dbCodes = require('../src/http').DB_ERRORS.map(([, code]) => code);
    for (const code of [...codes, ...dbCodes]) assert.ok(`err.${code}` in en, `missing err.${code}`);
    assert.ok(codes.length > 50, 'found the error sites');

    const fields = [...src.matchAll(/(?:required|optionalText)\(\s*[\w.]+,\s*'(\w+)'/g), ...src.matchAll(/uuidList\([^,]+,\s*'(\w+)'/g)]
        .map((m) => m[1]);
    for (const f of [...fields, 'volume_code', 'level_code', 'type_code', 'role_code']) {
        assert.ok(`field.${f}` in en, `missing field.${f}`);
    }
});

test('every message the database raises maps to an error code', () => {
    const { DB_ERRORS } = require('../src/http');
    const sql = filesIn(path.join(root, '..', 'db', 'migrations'), '.sql').map(read).join('\n');
    const formats = [...sql.matchAll(/RAISE EXCEPTION '([^']+)'/g)].map((m) => m[1]);
    assert.ok(formats.length >= 25, 'found the RAISE statements');
    for (const format of formats) {
        const sample = format.replace(/%/g, 'X1');   // % placeholders become one token
        assert.ok(DB_ERRORS.some(([re]) => re.test(sample)), `no error code for database message: ${format}`);
    }
});

test('every key the browser asks for exists', () => {
    const js = filesIn(path.join(root, 'public', 'js'), '.js').map(read).join('\n');
    const keys = [...js.matchAll(/\bt\(\s*'([a-z_][\w.]*)'/g)].map((m) => m[1]);
    const plurals = [...js.matchAll(/\btn\(\s*'([a-z_][\w.]*)'/g)].map((m) => m[1]);
    assert.ok(keys.length > 150, `found the UI strings (${keys.length})`);
    for (const k of keys) assert.ok(k in en, `missing ${k}`);
    for (const k of plurals) assert.ok(`${k}.other` in en && `${k}.one` in en, `missing plural forms of ${k}`);
});
