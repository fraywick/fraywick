// Remote probing with politeness: global concurrency, one request chain per host at a time, spacing between servers on the same
// host, per-host backoff on 429 / repeated failures, opt-out (sources/optout.json, robots.txt groups for FraywickBot), and a
// re-probe schedule so dead or auth-only servers are not hammered every hour.
import { request, makeAgents } from './net.mjs'
import { createProbe } from './lib/mcp-client.mjs'
import { userAgent, readJson, paths, VERSION } from './config.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** guarded transport for the shared MCP client (crawl policy, per-request timeout, per-probe deadline) */
export function guardedHttp({ policy = { mode: 'crawl' }, deadline = null, timeoutMs = 10_000, maxBytes, agents = null } = {}) {
  return (o) => request({ ...o, policy, agents, stream: true, noMethodChange: true, maxBytes: maxBytes ?? (policy.mode === 'check' ? 2_000_000 : 4_000_000),
    deadline: Math.min(deadline ?? Infinity, Date.now() + timeoutMs) })
}

export function makeProber(opts = {}) {
  return createProbe({ http: guardedHttp(opts), clientInfo: { name: 'FraywickBot', version: VERSION }, userAgent: userAgent() })
}

/** pick the remote to probe: first streamable-http without template variables, else first sse */
export function pickRemote(remotes = []) {
  const usable = remotes.filter((r) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url) && !/[{}]/.test(r.url))
  return usable.find((r) => r.type === 'streamable-http') || usable.find((r) => r.type === 'sse') || null
}
export const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase() } catch { return null } }

/** when a server is due again, given its last probe (epochs are hours) */
export function dueAt(prev, epoch) {
  if (!prev) return epoch
  const fails = Number(prev.fail_streak || 0)
  if (prev.status === 'ok') return prev.epoch + 1
  if (prev.status === 'auth_required') return prev.epoch + 6
  if (prev.status === 'needs_config' || prev.status === 'opted_out') return prev.epoch + 24
  if (prev.status === 'rate_limited') return prev.epoch + 2
  // errors: hourly for a server that worked recently, then 2, 4, 8 … 24 h
  const sinceOk = prev.last_ok_epoch != null ? prev.epoch - prev.last_ok_epoch : 999
  if (sinceOk <= 3) return prev.epoch + 1
  return prev.epoch + Math.min(24, 2 ** Math.min(4, Math.max(1, fails)))
}

/** robots.txt: only groups that name FraywickBot are honoured (MCP endpoints are APIs, not pages) */
export function robotsDisallows(text, path) {
  const groups = []
  let cur = null
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const k = m[1].toLowerCase(), v = m[2].trim()
    if (k === 'user-agent') { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur) } cur.agents.push(v.toLowerCase()) }
    else if ((k === 'disallow' || k === 'allow') && cur) cur.rules.push({ allow: k === 'allow', path: v })
  }
  const mine = groups.filter((g) => g.agents.some((a) => a.includes('fraywickbot')))
  if (!mine.length) return false
  let best = null
  for (const g of mine) for (const r of g.rules) {
    if (!r.path) continue
    if (path.startsWith(r.path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r
  }
  return !!best && !best.allow
}

export function createScheduler({ store, log = console, concurrency = Number(process.env.CONCURRENCY || 16), spacingMs = Number(process.env.HOST_SPACING_MS || 1000),
  probeTimeoutMs = Number(process.env.PROBE_TIMEOUT_MS || 30_000), requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 10_000), prober = null, robots = true } = {}) {
  const optout = () => {
    const j = readJson(paths.optout()) || {}
    return new Set((j.hosts || []).map((h) => String(h).toLowerCase()))
  }

  async function robotsFor(host, now) {
    if (!robots) return null
    const h = store.getHost(host)
    if (h?.robots_at && now - h.robots_at < 24 * 3600_000) return h.robots
    let text = ''
    try {
      const r = await request({ url: `https://${host}/robots.txt`, headers: { 'user-agent': userAgent() }, policy: { mode: 'crawl' }, timeoutMs: 5000, maxBytes: 256_000 })
      text = r.status === 200 ? r.text().slice(0, 100_000) : ''
    } catch {}
    store.putHost({ ...hostRow(h, host), robots: { text }, robotsAt: now })
    return { text }
  }
  const hostRow = (h, host) => ({ host, robots: h?.robots ?? null, robotsAt: h?.robots_at ?? null, optedOut: !!h?.opted_out, optReason: h?.opt_reason ?? null,
    backoffUntil: h?.backoff_until ?? null, lastStatus: h?.last_status ?? null })

  /**
   * run(tasks, { deadline, onResult }) — tasks: [{ serverId, url, type }]. Hosts run in parallel (≤ concurrency), servers of one host
   * one after another with spacing. Returns { results: Map(serverId → result), skippedHosts }.
   */
  async function run(tasks, { deadline = Infinity, onResult } = {}) {
    const byHost = new Map()
    for (const t of tasks) { const h = hostOf(t.url); if (!h) continue; if (!byHost.has(h)) byHost.set(h, []); byHost.get(h).push(t) }
    // big hosts first so they do not finish last
    const queue = [...byHost.entries()].sort((a, b) => b[1].length - a[1].length)
    const results = new Map()
    const skipped = []
    const blocked = optout()
    let qi = 0
    async function worker() {
      while (qi < queue.length) {
        const [host, list] = queue[qi++]
        const now = Date.now()
        const h = store.getHost(host)
        if (blocked.has(host)) {
          store.putHost({ ...hostRow(h, host), optedOut: true, optReason: 'sources/optout.json' })
          for (const t of list) { const r = { url: t.url, status: 'opted_out', error: 'host asked not to be crawled' }; results.set(t.serverId, r); onResult?.(t, r) }
          skipped.push({ host, reason: 'opt-out' }); continue
        }
        if (h?.backoff_until && h.backoff_until > now) { skipped.push({ host, reason: 'backoff' }); continue }
        const rb = await robotsFor(host, now)
        const disallowed = rb ? list.filter((t) => { try { return robotsDisallows(rb.text, new URL(t.url).pathname) } catch { return false } }) : []
        const h2 = store.getHost(host)
        if (!!h2?.opted_out !== disallowed.length > 0) store.putHost({ ...hostRow(h2, host), optedOut: disallowed.length > 0, optReason: disallowed.length ? 'robots.txt (FraywickBot group)' : null })
        const agents = makeAgents()
        let rateLimited = false
        for (const t of list) {
          if (Date.now() > deadline) { skipped.push({ host, reason: 'deadline' }); break }
          let r
          const path = (() => { try { return new URL(t.url).pathname } catch { return '/' } })()
          if (rb && robotsDisallows(rb.text, path)) r = { url: t.url, status: 'opted_out', error: 'robots.txt disallows FraywickBot' }
          else if (rateLimited) r = { url: t.url, status: 'rate_limited', error: 'host rate-limited us earlier in this crawl' }
          else {
            const p = prober || makeProber({ deadline: Math.min(deadline, Date.now() + probeTimeoutMs), timeoutMs: requestTimeoutMs, agents })
            // hard stop per probe on top of the request deadlines (a stuck stream must never stall the whole crawl)
            let timer
            const hard = new Promise((resolve) => { timer = setTimeout(() => resolve({ url: t.url, status: 'error', error: 'probe hard timeout' }), probeTimeoutMs + 5_000) })
            r = await Promise.race([p(t.url, { type: t.type, era: t.era }), hard])
            clearTimeout(timer)
          }
          results.set(t.serverId, r)
          onResult?.(t, r)
          if (r.status === 'rate_limited' && !rateLimited) {
            rateLimited = true
            const until = Date.now() + Math.min(6 * 3600, Math.max(600, r.retryAfterS || 3600)) * 1000
            store.putHost({ ...hostRow(store.getHost(host), host), backoffUntil: until, lastStatus: 'rate_limited' })
          }
          if (list.length > 1) await sleep(spacingMs)
        }
        agents.destroy()
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
    return { results, skipped, hosts: byHost.size }
  }
  return { run }
}
