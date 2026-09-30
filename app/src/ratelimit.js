'use strict';
// Rate limits shared by every app instance, stored in Postgres
// (rate_limit_counters, migration 0012). In-process counters gave an
// attacker N times the budget with N instances behind a load balancer.
// Keys are hashed before they reach the database, so no emails or IP
// addresses are stored.

const crypto = require('node:crypto');
const net = require('node:net');

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

// Seconds until all the given limits allow another attempt (0 = allowed).
// limits: [[key, max], ...]
async function blockedFor(db, limits) {
    const { rows } = await db.query('SELECT rate_limit_blocked($1, $2) AS s',
        [limits.map(([k]) => hashKey(k)), limits.map(([, max]) => max)]);
    return rows[0].s;
}

async function hit(db, keys, windowMs) {
    await db.query('SELECT rate_limit_hit($1, make_interval(secs => $2))',
        [keys.map(hashKey), windowMs / 1000]);
}

async function reset(db, key) {
    await db.query('SELECT rate_limit_reset($1)', [hashKey(key)]);
}

// The key to rate-limit a client by. One IPv6 subscriber normally gets a
// whole /64 (2^64 addresses), so limiting per address lets an attacker
// rotate addresses forever. IPv6 is keyed by its /64 prefix; IPv4 and
// IPv4-mapped IPv6 by the address.
function clientKey(ip) {
    if (!ip) return 'unknown';
    ip = String(ip).split('%')[0];
    const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) return mapped[1];
    if (!net.isIPv6(ip)) return ip;

    const [head, tail] = ip.split('::');
    const groups = (s) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
    const h = groups(head);
    const t = tail === undefined ? [] : groups(tail);
    const full = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

module.exports = { blockedFor, hit, reset, clientKey, hashKey };
