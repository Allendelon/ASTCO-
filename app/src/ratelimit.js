'use strict';
// Fixed-window counters in process memory. Enough for one instance; with
// several instances behind a load balancer, move the counters to a shared
// store (Redis, or a Postgres table) so limits apply across instances.

class RateLimiter {
    constructor({ windowMs, max }) {
        this.windowMs = windowMs;
        this.max = max;
        this.hits = new Map();
        this.sweeper = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
        this.sweeper.unref();
    }

    entry(key) {
        const now = Date.now();
        let e = this.hits.get(key);
        if (!e || e.resetAt <= now) {
            e = { count: 0, resetAt: now + this.windowMs };
            this.hits.set(key, e);
        }
        return e;
    }

    // Seconds until the key may try again, or 0 if it is under the limit.
    blockedFor(key) {
        const e = this.entry(key);
        return e.count >= this.max ? Math.ceil((e.resetAt - Date.now()) / 1000) : 0;
    }

    hit(key) {
        this.entry(key).count += 1;
    }

    reset(key) {
        this.hits.delete(key);
    }

    sweep() {
        const now = Date.now();
        for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
    }
}

module.exports = { RateLimiter };
