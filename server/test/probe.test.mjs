import { test } from 'node:test'
import assert from 'node:assert/strict'
import { robotsDisallows, dueAt, pickRemote, createScheduler } from '../probe.mjs'
import { openStore } from '../store.mjs'

test('robots.txt: only FraywickBot groups count; longest match wins', () => {
  assert.equal(robotsDisallows('User-agent: *\nDisallow: /', '/mcp'), false)
  assert.equal(robotsDisallows('User-agent: FraywickBot\nDisallow: /mcp', '/mcp'), true)
  assert.equal(robotsDisallows('User-agent: Googlebot\nUser-agent: FraywickBot\nDisallow: /\nAllow: /mcp', '/mcp'), false)
  assert.equal(robotsDisallows('User-agent: fraywickbot/1.0\nDisallow: /private', '/mcp'), false)
  assert.equal(robotsDisallows('', '/'), false)
})

test('re-probe schedule', () => {
  assert.equal(dueAt(null, 10), 10)
  assert.equal(dueAt({ status: 'ok', epoch: 9 }, 10), 10)
  assert.equal(dueAt({ status: 'auth_required', epoch: 9 }, 10), 15)
  assert.equal(dueAt({ status: 'error', epoch: 9, last_ok_epoch: 8 }, 10), 10)
  assert.equal(dueAt({ status: 'error', epoch: 9, last_ok_epoch: null, fail_streak: 1 }, 10), 11)
  assert.equal(dueAt({ status: 'error', epoch: 9, last_ok_epoch: null, fail_streak: 9 }, 10), 25)
})

test('pickRemote: streamable-http first, templated URLs skipped', () => {
  assert.equal(pickRemote([{ type: 'sse', url: 'https://a/sse' }, { type: 'streamable-http', url: 'https://a/mcp' }]).type, 'streamable-http')
  assert.equal(pickRemote([{ type: 'streamable-http', url: 'https://{tenant}.a/mcp' }]), null)
  assert.equal(pickRemote([{ type: 'streamable-http', url: 'file:///etc/passwd' }]), null)
})

test('scheduler: one chain per host, spacing, opt-out list, 429 pauses the host', async () => {
  const store = openStore({ memory: true })
  const active = new Map(), order = []
  let maxPerHost = 0
  const prober = async (url) => {
    const h = new URL(url).hostname
    active.set(h, (active.get(h) || 0) + 1); maxPerHost = Math.max(maxPerHost, active.get(h)); order.push(url)
    await new Promise((r) => setTimeout(r, 5))
    active.set(h, active.get(h) - 1)
    return url.includes('limit') ? { status: 'rate_limited', retryAfterS: 60 } : { status: 'ok', tools: [] }
  }
  const s = createScheduler({ store, prober, spacingMs: 1, concurrency: 4, robots: false })
  const tasks = [...Array(5)].map((_, i) => ({ serverId: `a${i}`, url: `https://a.example/s${i}` }))
    .concat([...Array(3)].map((_, i) => ({ serverId: `b${i}`, url: `https://b.example/limit${i}` })))
  const r = await s.run(tasks)
  assert.equal(maxPerHost, 1)
  assert.equal(r.results.get('b0').status, 'rate_limited')
  assert.equal(r.results.get('b1').error, 'host rate-limited us earlier in this crawl')
  assert.equal(order.filter((u) => u.includes('b.example')).length, 1)
  assert.ok(store.getHost('b.example').backoff_until > Date.now())
  // next run: b.example is in backoff and skipped entirely
  const r2 = await s.run(tasks.filter((t) => t.serverId.startsWith('b')))
  assert.equal(r2.results.size, 0); assert.equal(r2.skipped[0].reason, 'backoff')
})
