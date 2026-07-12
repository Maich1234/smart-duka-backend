// Optional shared rate-limit store backed by Upstash Redis (REST API).
//
// express-rate-limit's default MemoryStore is per-instance: on Vercel every
// cold start / concurrent instance gets fresh counters, so limits are only
// advisory. When UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set,
// this store makes the counters global. Without them, limiters silently fall
// back to the in-memory store (dev, self-hosted single instance).
//
// Deliberately dependency-free: uses global fetch (Node 18+) against the
// Upstash REST pipeline endpoint. Fails OPEN — if Redis is unreachable the
// request is allowed rather than taking login down with it.

class UpstashRateLimitStore {
  constructor({ url, token, prefix }) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.prefix = prefix;
    this.windowMs = 60_000;
    // Each limiter needs its own store instance (its own prefix), so
    // express-rate-limit can't share one across limiters.
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async #pipeline(commands) {
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`Upstash ${res.status}`);
    return res.json();
  }

  #key(key) {
    return `rl:${this.prefix}:${key}`;
  }

  async increment(key) {
    try {
      const k = this.#key(key);
      const [incr, pttl] = await this.#pipeline([
        ['INCR', k],
        ['PTTL', k],
      ]);
      let ttl = pttl?.result;
      // First hit in a window (or a key that somehow lost its expiry):
      // start the window now.
      if (ttl == null || ttl < 0) {
        ttl = this.windowMs;
        await this.#pipeline([['PEXPIRE', k, String(this.windowMs)]]);
      }
      return {
        totalHits: incr?.result ?? 1,
        resetTime: new Date(Date.now() + ttl),
      };
    } catch {
      // Fail open: never let a Redis outage block sign-ins.
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key) {
    try {
      await this.#pipeline([['DECR', this.#key(key)]]);
    } catch {
      /* fail open */
    }
  }

  async resetKey(key) {
    try {
      await this.#pipeline([['DEL', this.#key(key)]]);
    } catch {
      /* fail open */
    }
  }
}

/**
 * Returns a shared store for express-rate-limit's `store` option, or
 * undefined to use the default in-memory store. `prefix` isolates each
 * limiter's counters (e.g. 'login', 'otp-request').
 */
export const createRateLimitStore = (prefix) => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return undefined;
  return new UpstashRateLimitStore({ url, token, prefix });
};
