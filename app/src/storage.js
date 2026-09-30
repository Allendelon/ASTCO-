'use strict';
// Content-addressed file store on local disk. The object key is the SHA-256
// the server computed while receiving the bytes, so a key names the exact
// content and the client never supplies a hash we have to trust.
// Swap for S3 (with Object Lock) in production; the interface is three functions.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ROOT = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage'));
const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024;
const KEY_RE = /^[0-9a-f]{64}$/;

class TooLargeError extends Error {}

// Content type from the file's leading bytes. Only these types may ever be
// shown inline, so the client's claimed type is never trusted for them.
function sniff(head) {
    const starts = (sig, at = 0) => head.length >= at + sig.length && sig.every((b, i) => head[at + i] === b);
    if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';                        // %PDF-
    if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (starts([0x47, 0x49, 0x46, 0x38]) && [0x37, 0x39].includes(head[4]) && head[5] === 0x61) return 'image/gif';
    if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
    return 'application/octet-stream';
}

function objectPath(key) {
    if (!KEY_RE.test(key)) throw new Error('invalid object key');
    return path.join(ROOT, key.slice(0, 2), key);
}

// Streams to a temp file while hashing, then moves it to its content address.
// Files and directories are private to the service account.
async function putStream(readable, { maxBytes = MAX_BYTES } = {}) {
    await fsp.mkdir(path.join(ROOT, 'tmp'), { recursive: true, mode: 0o700 });
    const tmp = path.join(ROOT, 'tmp', crypto.randomUUID());
    const hash = crypto.createHash('sha256');
    const limit = Math.min(maxBytes, MAX_BYTES);
    let size = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
        transform(chunk, _enc, cb) {
            size += chunk.length;
            if (size > limit) return cb(new TooLargeError(`file is larger than the ${Math.floor(limit / 1024 / 1024)} MB allowed`));
            if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
            hash.update(chunk);
            cb(null, chunk);
        },
    });
    try {
        await pipeline(readable, meter, fs.createWriteStream(tmp, { mode: 0o600 }));
    } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
    }
    if (size === 0) {
        await fsp.rm(tmp, { force: true });
        throw new Error('file is empty');
    }
    const key = hash.digest('hex');
    const dest = objectPath(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    if (fs.existsSync(dest)) await fsp.rm(tmp);   // same content already stored
    else await fsp.rename(tmp, dest);
    return { key, size, mime: sniff(head) };
}

async function stat(key) {
    try {
        return await fsp.stat(objectPath(key));
    } catch {
        return null;
    }
}

function createReadStream(key) {
    return fs.createReadStream(objectPath(key));
}

module.exports = { putStream, stat, createReadStream, sniff, TooLargeError, KEY_RE, MAX_BYTES };
