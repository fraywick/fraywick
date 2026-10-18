// Outbound HTTP for everything FRAYWICK fetches (registry, MCP remotes, npm, PyPI, GitHub, /api/check targets).
// Every connection goes through the SSRF guard: the host name is resolved once, every resolved address must be public, and the
// socket connects to the address that was checked (custom `lookup`), so a DNS rebind between check and connect is impossible.
// Redirects are followed by hand (max 3) and every hop is checked again. Bodies are size-capped after decompression.
//
// policy.mode 'check' (user URLs, BRIEF): https only (http only for hosts in CHECK_HTTP_ALLOW), ports 443/8443 only, 2 MB, 10 s total.
// policy.mode 'crawl' (registry data, still hostile): http/https, any port except a few service ports, bigger caps.
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream'
import { isIP } from 'node:net'

// ───────────────────────────── address classification
function v4parts(ip) {
  const p = ip.split('.').map(Number)
  return p.length === 4 && p.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? p : null
}
const V4_BLOCK = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([a, n]) => [v4parts(a).reduce((x, y) => x * 256 + y, 0), n])
function v4blocked(ip) {
  const p = v4parts(ip)
  if (!p) return true
  const n = p.reduce((x, y) => x * 256 + y, 0)
  return V4_BLOCK.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)))
}
/** 8 hextets as numbers (handles "::" and a trailing dotted IPv4), or null */
export function v6hextets(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const pct = s.indexOf('%'); if (pct >= 0) s = s.slice(0, pct)
  let tail = []
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (m) { const p = v4parts(m[2]); if (!p) return null; tail = [p[0] * 256 + p[1], p[2] * 256 + p[3]]; s = m[1].endsWith('::') ? m[1] : m[1].slice(0, -1) }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (x) => (x === '' ? [] : x.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)))
  const head = parse(halves[0]), rest = halves.length === 2 ? parse(halves[1]) : []
  const total = head.length + rest.length + tail.length
  if (halves.length === 1 && total !== 8) return null
  if (halves.length === 2 && total > 7) return null
  const out = [...head, ...Array(8 - total).fill(0), ...rest, ...tail]
  return out.length === 8 && out.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? out : null
}
function v6blocked(ip) {
  const h = v6hextets(ip)
  if (!h) return true
  const embedded = (a, b) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`
  if (h.slice(0, 7).every((x) => x === 0)) return true                                           // :: and ::1
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return v4blocked(embedded(h[6], h[7])) // ::ffff:a.b.c.d mapped
  if (h.slice(0, 6).every((x) => x === 0)) return true                                           // ::a.b.c.d (IPv4-compatible, deprecated)
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0xffff && h[5] === 0) return true // ::ffff:0:a.b.c.d (SIIT)
  if (h[0] === 0x64 && h[1] === 0xff9b) return true                                               // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (h[0] === 0x100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true                       // 100::/64 discard
  if (h[0] === 0x2001 && h[1] < 0x200) return true                                                // 2001::/23 IETF special (Teredo, ORCHID, …)
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true                                              // documentation
  if (h[0] === 0x2002) return true                                                                // 6to4 (embeds an IPv4)
  if (h[0] === 0x3fff && h[1] < 0x1000) return true                                               // 3fff::/20 documentation
  if ((h[0] & 0xfe00) === 0xfc00) return true                                                     // fc00::/7 ULA (incl. fd00:ec2::254)
  if ((h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0) return true                       // link-local, site-local
  if ((h[0] & 0xff00) === 0xff00) return true                                                     // multicast
  return (h[0] & 0xe000) !== 0x2000                                                                // only 2000::/3 is global unicast
}
let testAllow = new Set()
/** tests only: treat these exact addresses as public (local fake servers) */
export function _testAllow(ips = []) { testAllow = new Set(ips) }
/** true when an address may be connected to (public unicast) */
export function ipAllowed(ip) {
  if (testAllow.size && testAllow.has(String(ip))) return true
  const fam = isIP(String(ip).replace(/^\[|\]$/g, '').replace(/%.*$/, ''))
  if (fam === 4) return !v4blocked(ip)
  if (fam === 6) return !v6blocked(ip)
  return false
}

const BAD_HOST = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa|home\.arpa|onion|test|invalid|example)$/i
const CRAWL_DENY_PORTS = new Set([21, 22, 23, 25, 53, 110, 111, 135, 139, 143, 389, 445, 465, 587, 993, 995, 1433, 1521, 2049, 2375, 2376, 2379, 3306, 3389,
  5432, 5672, 5900, 6379, 6443, 9200, 9300, 10250, 11211, 15672, 27017])

export class GuardError extends Error { constructor(code, msg) { super(msg || code); this.code = code; this.guard = true } }

/** URL-level checks (before DNS): scheme, port, host name shape, credentials */
export function checkUrl(input, policy = {}) {
  let u
  try { u = new URL(String(input)) } catch { throw new GuardError('bad_url', 'not a valid URL') }
  const mode = policy.mode || 'check'
  const httpAllow = new Set((policy.httpAllow ?? String(process.env.CHECK_HTTP_ALLOW || '').split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean))
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new GuardError('scheme', 'only https URLs are allowed')
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (u.protocol === 'http:' && mode === 'check' && !httpAllow.has(host)) throw new GuardError('scheme', 'only https URLs are allowed')
  if (u.username || u.password) throw new GuardError('credentials', 'URLs with credentials are not allowed')
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80)
  if (mode === 'check') {
    const ok = u.protocol === 'https:' ? port === 443 || port === 8443 : port === 80
    if (!ok) throw new GuardError('port', 'only ports 443 and 8443 are allowed')
  } else if (CRAWL_DENY_PORTS.has(port) || port < 1 || port > 65535) throw new GuardError('port', `port ${port} is not allowed`)
  if (!host) throw new GuardError('host', 'missing host')
  if (isIP(host)) { if (!ipAllowed(host)) throw new GuardError('private_ip', 'address is not public') }
  else if (testAllow.size && testAllow.has(host)) { /* tests */ }
  else {
    if (!host.includes('.') || BAD_HOST.test(host)) throw new GuardError('host', 'host name is not public')
    if (!/^[a-z0-9.-]+$/.test(host)) throw new GuardError('host', 'host name has invalid characters')
  }
  return { url: u, host, port }
}

let resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true })
export function _setResolver(fn) { resolver = fn || ((host) => dns.promises.lookup(host, { all: true, verbatim: true })) }

/** resolve once; every address must be public; returns the address to connect to */
export async function resolvePublic(host) {
  if (isIP(host)) { if (!ipAllowed(host)) throw new GuardError('private_ip', 'address is not public'); return { address: host, family: isIP(host) } }
  let addrs
  try { addrs = await resolver(host) } catch (e) { throw new GuardError('dns', `DNS lookup failed (${e.code || e.message})`) }
  if (!addrs || !addrs.length) throw new GuardError('dns', 'DNS returned no address')
  const bad = addrs.find((a) => !ipAllowed(a.address))
  if (bad) throw new GuardError('private_ip', 'host resolves to a non-public address')
  const pick = addrs.find((a) => a.family === 4) || addrs[0]
  return { address: pick.address, family: pick.family }
}

// ───────────────────────────── request
const DEFAULTS = {
  check: { maxBytes: 2_000_000, timeoutMs: 10_000, maxRedirects: 3 },
  crawl: { maxBytes: 8_000_000, timeoutMs: 20_000, maxRedirects: 3 },
}

/**
 * request({ url, method, headers, body, policy, deadline, maxBytes, stream })
 *  → { status, headers, url, text(), json(), chunks() (async iterator, size-capped), close() }
 * deadline: absolute ms (shared across several requests of one check). stream=true returns before the body is read.
 */
export async function request(o) {
  const policy = o.policy || { mode: 'check' }
  const d = DEFAULTS[policy.mode || 'check']
  const maxBytes = o.maxBytes ?? policy.maxBytes ?? d.maxBytes
  const deadline = o.deadline ?? Date.now() + (o.timeoutMs ?? policy.timeoutMs ?? d.timeoutMs)
  const maxRedirects = policy.maxRedirects ?? d.maxRedirects
  let url = String(o.url), method = (o.method || 'GET').toUpperCase(), body = o.body
  for (let hop = 0; ; hop++) {
    const { url: u, host, port } = checkUrl(url, policy)
    if (Date.now() >= deadline) throw new GuardError('timeout', 'timed out')
    if (process.env.NO_NETWORK === '1' && !testAllow.size) throw new GuardError('offline', 'network disabled (NO_NETWORK=1)')
    const target = await resolvePublic(host)
    if (process.env.NO_NETWORK === '1' && !testAllow.has(target.address)) throw new GuardError('offline', 'network disabled (NO_NETWORK=1)')
    const res = await once({ u, host, port, method, headers: o.headers || {}, body, target, deadline, maxBytes, signal: o.signal, agent: o.agents?.[u.protocol] || false })
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      res.close()
      if (hop >= maxRedirects) throw new GuardError('redirects', 'too many redirects')
      const next = new URL(res.headers.location, u).toString()
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        if (o.noMethodChange) throw new GuardError('redirect_method', 'redirect would change the request method')
        method = 'GET'; body = undefined
      }
      url = next
      continue
    }
    res.url = u.toString()
    if (!o.stream) await res.load()
    return res
  }
}

function once({ u, host, port, method, headers, body, target, deadline, maxBytes, signal, agent }) {
  const lib = u.protocol === 'https:' ? https : http
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const hdrs = { 'accept-encoding': 'gzip, deflate, br', ...lowerKeys(headers) }
  if (payload) hdrs['content-length'] = String(payload.length)
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (e) => { if (!settled) { settled = true; reject(e) } }
    const req = lib.request({
      host, port, method, path: u.pathname + u.search, headers: hdrs, servername: isIP(host) ? undefined : host,
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: target.address, family: target.family }]) : cb(null, target.address, target.family)),
      agent,
    })
    const timer = setTimeout(() => { req.destroy(new GuardError('timeout', 'timed out')) }, Math.max(1, deadline - Date.now()))
    const onAbort = () => req.destroy(new GuardError('aborted', 'aborted'))
    signal?.addEventListener?.('abort', onAbort, { once: true })
    req.on('error', (e) => { clearTimeout(timer); fail(e.guard ? e : new GuardError('network', netMsg(e))) })
    req.on('response', (res) => {
      // the socket must still be the address we checked
      const ra = res.socket?.remoteAddress
      if (ra && !ipAllowed(ra.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1'))) { req.destroy(); clearTimeout(timer); return fail(new GuardError('private_ip', 'connected to a non-public address')) }
      let stream = res
      const enc = String(res.headers['content-encoding'] || '').toLowerCase()
      const dec = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null
      // pipeline (not pipe): destroying the response on timeout must also end the decoder, or a reader would wait forever
      if (dec) stream = pipeline(res, dec, () => {})
      let bytes = 0, buf = null, closed = false
      const close = () => { if (!closed) { closed = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); res.destroy(); if (stream !== res) stream.destroy() } }
      async function* chunks() {
        try {
          for await (const c of stream) {
            bytes += c.length
            if (bytes > maxBytes) throw new GuardError('too_large', `response larger than ${maxBytes} bytes`)
            yield c
          }
        } catch (e) { throw e.guard ? e : new GuardError(req.destroyed && Date.now() >= deadline ? 'timeout' : 'network', netMsg(e)) }
        finally { close() }
      }
      const out = {
        status: res.statusCode, headers: res.headers, chunks,
        close,
        async load() { if (buf) return buf; const parts = []; for await (const c of chunks()) parts.push(c); buf = Buffer.concat(parts); return buf },
        text() { return (buf || Buffer.alloc(0)).toString('utf8') },
        json() { try { return JSON.parse(out.text()) } catch { return undefined } },
        get bytes() { return bytes },
      }
      settled = true
      resolve(out)
    })
    if (payload) req.write(payload)
    req.end()
  })
}
/** keep-alive agents for one probe / one host chain (sockets only ever connect to addresses that passed the guard) */
export function makeAgents() {
  const a = { 'https:': new https.Agent({ keepAlive: true, maxSockets: 2, timeout: 15_000 }), 'http:': new http.Agent({ keepAlive: true, maxSockets: 2, timeout: 15_000 }) }
  a.destroy = () => { a['https:'].destroy(); a['http:'].destroy() }
  return a
}
const lowerKeys = (h) => Object.fromEntries(Object.entries(h).filter(([, v]) => v != null).map(([k, v]) => [k.toLowerCase(), String(v)]))
const netMsg = (e) => (e?.code ? `${e.code}` : String(e?.message || e)).slice(0, 200)
