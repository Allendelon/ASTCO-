'use strict';
// Demo data for local development: three organisations on one project, users
// with a shared password, code lists, and a few documents with real files.
// Refuses to run when NODE_ENV=production.

const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pool, withTx } = require('../src/db');
const { hashPassword } = require('../src/auth');
const storage = require('../src/storage');

if (process.env.NODE_ENV === 'production') {
    console.error('seed.js is for development only.');
    process.exit(1);
}

const PASSWORD = process.env.SEED_PASSWORD || 'cde-demo-2026';

const ORGS = [
    { id: 'a1000000-0000-4000-8000-000000000001', name: 'ASTCO Contracting', code: 'AST' },
    { id: 'a1000000-0000-4000-8000-000000000002', name: 'Meridian Engineering Consultants', code: 'MEC' },
    { id: 'a1000000-0000-4000-8000-000000000003', name: 'Riyadh Development Authority', code: 'RDA' },
];
const USERS = [
    { id: 'b1000000-0000-4000-8000-000000000001', org: 0, email: 'dc@astco.test', name: 'Huda Al-Qahtani', role: 'DOC_CONTROLLER' },
    { id: 'b1000000-0000-4000-8000-000000000002', org: 0, email: 'site@astco.test', name: 'Omar Farouk', role: 'MEMBER' },
    { id: 'b1000000-0000-4000-8000-000000000003', org: 1, email: 'mep@meridian.test', name: 'Daniel Okafor', role: 'MEMBER' },
    { id: 'b1000000-0000-4000-8000-000000000004', org: 1, email: 'dc@meridian.test', name: 'Priya Raman', role: 'DOC_CONTROLLER' },
    { id: 'b1000000-0000-4000-8000-000000000005', org: 2, email: 'pm@rda.test', name: 'Faisal Al-Harbi', role: 'ADMIN' },
];
const PROJECT = { id: 'c1000000-0000-4000-8000-000000000001', code: 'KAFD', name: 'KAFD Tower 7 – MEP Fit-out' };
const CODES = {
    VOLUME: [['ZZ', 'All volumes'], ['T7', 'Tower 7'], ['PD', 'Podium']],
    LEVEL: [['ZZ', 'Multiple levels'], ['B1', 'Basement 1'], ['00', 'Ground'], ['01', 'Level 01'], ['02', 'Level 02'], ['RF', 'Roof']],
    TYPE: [['DR', 'Drawing'], ['M3', '3D model'], ['SP', 'Specification'], ['CA', 'Calculation'], ['RP', 'Report'], ['MS', 'Method statement']],
    ROLE: [['A', 'Architect'], ['M', 'Mechanical'], ['E', 'Electrical'], ['P', 'Public health'], ['S', 'Structural'], ['C', 'Civil']],
};

// A one-page PDF with a title block, built by hand so the seed needs no library.
function makePdf(lines) {
    const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 20 : 11} Tf 60 ${740 - i * 26} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
    const stream = `0.2 w 40 40 515 762 re S 40 100 m 555 100 l S\n${text}`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let out = '%PDF-1.4\n';
    const offsets = objects.map((body, i) => {
        const at = Buffer.byteLength(out);
        out += `${i + 1} 0 obj\n${body}\nendobj\n`;
        return at;
    });
    const xref = Buffer.byteLength(out);
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

// A simple floor-plan PNG (walls and a grid) to pin inspections on.
function makeFloorPlanPng(w = 1200, h = 800) {
    const px = Buffer.alloc(w * h * 3, 0xff);
    const set = (x, y, [r, g, b]) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const i = (y * w + x) * 3;
        px[i] = r; px[i + 1] = g; px[i + 2] = b;
    };
    const grid = [218, 226, 232], wall = [40, 52, 62];
    for (let x = 0; x < w; x += 50) for (let y = 0; y < h; y++) set(x, y, grid);
    for (let y = 0; y < h; y += 50) for (let x = 0; x < w; x++) set(x, y, grid);
    const rect = (x0, y0, x1, y1, t = 6) => {
        for (let x = x0; x <= x1; x++) for (let k = 0; k < t; k++) { set(x, y0 + k, wall); set(x, y1 - k, wall); }
        for (let y = y0; y <= y1; y++) for (let k = 0; k < t; k++) { set(x0 + k, y, wall); set(x1 - k, y, wall); }
    };
    rect(100, 100, 1100, 700, 10);
    rect(100, 100, 450, 400); rect(450, 100, 800, 400); rect(800, 100, 1100, 400);
    rect(100, 400, 600, 700); rect(600, 400, 900, 700); rect(900, 400, 1100, 550);

    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
}

async function seed() {
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const exists = (await db.query('SELECT 1 FROM projects WHERE id = $1', [PROJECT.id])).rowCount;
        if (exists) {
            await db.query('ROLLBACK');
            console.log('Demo data already present.');
            return false;
        }
        // Demo accounts share a published password. Never add them to a
        // database that holds anything else, whatever NODE_ENV says.
        const others = (await db.query('SELECT count(*)::int AS n FROM projects')).rows[0].n;
        if (others > 0) {
            await db.query('ROLLBACK');
            throw new Error('This database already has projects. The demo seed only runs on an empty database.');
        }
        for (const o of ORGS) await db.query('INSERT INTO organizations (id, legal_name) VALUES ($1, $2)', [o.id, o.name]);
        const hash = await hashPassword(PASSWORD);
        for (const u of USERS) {
            await db.query('INSERT INTO users (id, organization_id, email, display_name) VALUES ($1, $2, $3, $4)',
                [u.id, ORGS[u.org].id, u.email, u.name]);
            await db.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [u.id, hash]);
        }
        await db.query('INSERT INTO projects (id, owner_org_id, code, name) VALUES ($1, $2, $3, $4)',
            [PROJECT.id, ORGS[2].id, PROJECT.code, PROJECT.name]);
        for (const o of ORGS) {
            await db.query('INSERT INTO project_organizations (project_id, organization_id, originator_code) VALUES ($1, $2, $3)',
                [PROJECT.id, o.id, o.code]);
        }
        for (const u of USERS) {
            await db.query('INSERT INTO project_members (project_id, user_id, organization_id, role) VALUES ($1, $2, $3, $4)',
                [PROJECT.id, u.id, ORGS[u.org].id, u.role]);
        }
        for (const [field, list] of Object.entries(CODES)) {
            for (const [code, description] of list) {
                await db.query('INSERT INTO project_code_values (project_id, field, code, description) VALUES ($1, $2, $3, $4)',
                    [PROJECT.id, field, code, description]);
            }
        }
        await db.query('SELECT seed_uk_na_suitability_codes($1)', [PROJECT.id]);
        await db.query('COMMIT');
    } catch (err) {
        await db.query('ROLLBACK');
        throw err;
    } finally {
        db.release();
    }

    // Documents are created as the contractor's document controller, through RLS.
    const docs = [
        { v: 'T7', l: '01', t: 'DR', r: 'M', title: 'Level 01 HVAC ductwork layout', png: true, suit: ['S0', 'S2'] },
        { v: 'T7', l: '01', t: 'DR', r: 'E', title: 'Level 01 small power and lighting layout', suit: ['S3'] },
        { v: 'T7', l: 'RF', t: 'DR', r: 'M', title: 'Roof plant arrangement', suit: ['S0'] },
        { v: 'ZZ', l: 'ZZ', t: 'SP', r: 'M', title: 'Chilled water system specification', suit: ['S2', 'S4'] },
        { v: 'T7', l: 'B1', t: 'MS', r: 'P', title: 'Method statement – drainage pipe installation', suit: ['S3'] },
    ];
    await withTx({ userId: USERS[0].id, ip: '127.0.0.1' }, async (tx) => {
        for (const [i, d] of docs.entries()) {
            const number = String(i + 1).padStart(4, '0');
            const doc = (await tx.query(
                `INSERT INTO cde_documents (project_id, project_code, originator_org_id, originator_code, volume_code,
                        level_code, type_code, role_code, number_code, title)
                 VALUES ($1, $2, $3, 'AST', $4, $5, $6, $7, $8, $9) RETURNING id, document_number`,
                [PROJECT.id, PROJECT.code, ORGS[0].id, d.v, d.l, d.t, d.r, number, d.title])).rows[0];
            // Each suitability step gets its own file, as it would in practice.
            let rev = [0, 0];
            for (const [k, suit] of d.suit.entries()) {
                const wip = suit === 'S0';
                rev = wip ? [rev[0] + 1, 1] : [rev[1] ? rev[0] : rev[0] + 1, null];
                const label = `P${String(rev[0]).padStart(2, '0')}${rev[1] ? `.0${rev[1]}` : ''}`;
                const body = d.png && k === d.suit.length - 1
                    ? makeFloorPlanPng()
                    : makePdf([doc.document_number, d.title, `Revision ${label}  Suitability ${suit}`, 'ASTCO Contracting', PROJECT.name]);
                const { key, size, mime } = await storage.putStream(Readable.from([body]));
                const upload = (await tx.query(
                    `SELECT upload_begin($1, $2, $3, 4, interval '15 minutes') AS id`,
                    [PROJECT.id, size, 1024 ** 4])).rows[0].id;
                await tx.query('SELECT upload_complete($1, $2, $3, $4)', [upload, key, size, mime]);
                await tx.query(
                    `INSERT INTO cde_document_revisions (document_id, project_id, originator_org_id, revision_prefix,
                            revision_major, revision_minor, suitability_code, cde_state, object_key, sha256, size_bytes,
                            mime_type, original_filename)
                     VALUES ($1, $2, $3, 'P', $4, $5, $6, $7, $8, decode($8, 'hex'), $9, $10, $11)`,
                    [doc.id, PROJECT.id, ORGS[0].id, rev[0], rev[1], suit, wip ? 'WIP' : 'SHARED', key, size, mime,
                     `${doc.document_number}.${mime === 'image/png' ? 'png' : 'pdf'}`]);
            }
        }
    });
    return true;
}

if (require.main === module) {
    seed().then((created) => {
        if (created) {
            console.log(`Seeded project ${PROJECT.code}. Sign in with any of these (password: ${PASSWORD}):`);
            for (const u of USERS) console.log(`  ${u.email.padEnd(20)} ${u.name} – ${ORGS[u.org].name}, ${u.role}`);
        }
        return pool.end();
    }, (err) => { console.error(err); process.exit(1); });
}

module.exports = { seed, USERS, ORGS, PROJECT, PASSWORD, makePdf, makeFloorPlanPng };
