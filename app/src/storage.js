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

function objectPath(key) {
    if (!KEY_RE.test(key)) throw new Error('invalid object key');
    return path.join(ROOT, key.slice(0, 2), key);
}

async function putStream(readable) {
    await fsp.mkdir(path.join(ROOT, 'tmp'), { recursive: true });
    const tmp = path.join(ROOT, 'tmp', crypto.randomUUID());
    const hash = crypto.createHash('sha256');
    let size = 0;
    const meter = new Transform({
        transform(chunk, _enc, cb) {
            size += chunk.length;
            if (size > MAX_BYTES) return cb(new TooLargeError(`file is larger than ${MAX_BYTES / 1024 / 1024} MB`));
            hash.update(chunk);
            cb(null, chunk);
        },
    });
    try {
        await pipeline(readable, meter, fs.createWriteStream(tmp));
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
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) await fsp.rm(tmp);   // same content already stored
    else await fsp.rename(tmp, dest);
    return { key, size };
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

module.exports = { putStream, stat, createReadStream, TooLargeError, KEY_RE };
