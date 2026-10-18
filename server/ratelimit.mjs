// Per-key token buckets in memory (one API process). Old buckets are swept.
export function createLimiter({ rate, burst, now = () => Date.now() }) {
  const buckets = new Map()
  let sweep = now()
  return {
    /** true when allowed; consumes one token */
    take(key) {
      const t = now()
      if (t - sweep > 60_000) { for (const [k, b] of buckets) if (t - b.t > 600_000) buckets.delete(k); sweep = t }
      const b = buckets.get(key) || { tokens: burst, t }
      b.tokens = Math.min(burst, b.tokens + ((t - b.t) / 1000) * rate)
      b.t = t
      if (b.tokens < 1) { buckets.set(key, b); return false }
      b.tokens -= 1
      buckets.set(key, b)
      return true
    },
    retryAfter(key) { const b = buckets.get(key); return b ? Math.max(1, Math.ceil((1 - b.tokens) / rate)) : 1 },
  }
}
