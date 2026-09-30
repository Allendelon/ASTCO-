'use strict';
// Fixed-window counters in process memory. Enough for one instance; with
// several instances behind a load balancer, move the counters to a shared
// store (Redis, or a Postgres table) so limits apply across instances.

const net = require('node:net');

class RateLimiter {
    constructor({ windowMs, max, maxKeys = 100_000 }) {
        this.windowMs = windowMs;
        this.max = max;
        this.maxKeys = maxKeys;
        this.hits = new Map();
        this.sweeper = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
        this.sweeper.unref();
    }

    // Seconds until the key may try again, or 0 if it is under the limit.
    // Read-only: checking a key never creates an entry, so requests that
    // are not failures cannot grow the table.
    blockedFor(key) {
        const e = this.hits.get(key);
        if (!e || e.resetAt <= Date.now() || e.count < this.max) return 0;
        return Math.ceil((e.resetAt - Date.now()) / 1000);
    }

    hit(key) {
        const now = Date.now();
        let e = this.hits.get(key);
        if (!e || e.resetAt <= now) {
            if (!e && this.hits.size >= this.maxKeys) this.makeRoom();
            e = { count: 0, resetAt: now + this.windowMs };
            this.hits.delete(key);   // re-insert so Map order stays oldest-first
            this.hits.set(key, e);
        }
        e.count += 1;
    }

    reset(key) {
        this.hits.delete(key);
    }

    sweep() {
        const now = Date.now();
        for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
    }

    // Bounded memory: drop expired entries, then the oldest ones.
    makeRoom() {
        this.sweep();
        const excess = this.hits.size - this.maxKeys + 1;
        if (excess <= 0) return;
        let n = 0;
        for (const k of this.hits.keys()) {
            if (n++ >= excess) break;
            this.hits.delete(k);
        }
    }
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

module.exports = { RateLimiter, clientKey };
