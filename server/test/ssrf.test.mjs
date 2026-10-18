import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { ipAllowed, checkUrl, resolvePublic, request, _setResolver, v6hextets } from '../net.mjs'
import { serve, allowLocal, resetNet } from './helpers.mjs'
import { gzipSync } from 'node:zlib'

after(resetNet)

test('ipAllowed: private, loopback, link-local, CGNAT, multicast, metadata, reserved are blocked', () => {
  const blocked = ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.100.100.200', '0.0.0.0',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.0.170', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.9',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1', '::127.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1',
    'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd00:ec2::254', 'fec0::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:7f00:1::1', '100::1', '3fff::1', 'not-an-ip', '1.2.3']
  for (const ip of blocked) assert.equal(ipAllowed(ip), false, ip)
  const ok = ['8.8.8.8', '1.1.1.1', '104.16.0.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8']
  for (const ip of ok) assert.equal(ipAllowed(ip), true, ip)
  assert.deepEqual(v6hextets('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304])
})

test('checkUrl (check mode): https only, ports 443/8443, no credentials, no internal names, IP literals normalized', () => {
  const bad = ['http://example.com/mcp', 'ftp://example.com', 'https://example.com:8080/', 'https://user:pw@example.com/', 'https://localhost/', 'https://foo.localhost/',
    'https://metadata.google.internal/', 'https://intranet/', 'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/',
    'https://169.254.169.254/latest/meta-data/', 'https://[fd00:ec2::254]/', 'https://printer.local/', 'javascript:alert(1)', 'not a url']
  for (const u of bad) assert.throws(() => checkUrl(u, { mode: 'check' }), (e) => e.guard, u)
  assert.ok(checkUrl('https://mcp.example.com/mcp', { mode: 'check' }))
  assert.ok(checkUrl('https://mcp.example.com:8443/mcp', { mode: 'check' }))
  assert.ok(checkUrl('http://allowed.example.com/mcp', { mode: 'check', httpAllow: ['allowed.example.com'] }))
  assert.ok(checkUrl('http://mcp.example.com:8080/mcp', { mode: 'crawl' }))
  assert.throws(() => checkUrl('https://mcp.example.com:22/', { mode: 'crawl' }))
  assert.throws(() => checkUrl('http://10.1.2.3/', { mode: 'crawl' }))
})

test('DNS: any private answer rejects the host; public answer is pinned', async () => {
  _setResolver(async (h) => (h === 'mixed.example.com' ? [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]
    : h === 'v6.example.com' ? [{ address: '::ffff:192.168.0.1', family: 6 }] : [{ address: '93.184.216.34', family: 4 }]))
  await assert.rejects(resolvePublic('mixed.example.com'), (e) => e.code === 'private_ip')
  await assert.rejects(resolvePublic('v6.example.com'), (e) => e.code === 'private_ip')
  assert.deepEqual(await resolvePublic('ok.example.com'), { address: '93.184.216.34', family: 4 })
  _setResolver(null)
})

test('DNS rebinding: resolved once per hop, the socket connects to the checked address', async () => {
  const srv = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello') })
  let calls = 0
  allowLocal()
  _setResolver(async () => { calls++; return calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.1', family: 4 }] })
  const r = await request({ url: srv.url('/', 'rebind.fake-host.dev'), policy: { mode: 'crawl' } })
  assert.equal(r.status, 200); assert.equal(r.text(), 'hello'); assert.equal(calls, 1)
  // a second request resolves again and is refused (the "rebound" private answer)
  await assert.rejects(request({ url: srv.url('/', 'rebind.fake-host.dev'), policy: { mode: 'crawl' } }), (e) => e.code === 'private_ip')
  await srv.close(); resetNet()
})

test('redirects: re-checked every hop (private target refused), max 3, POST never silently becomes GET', async () => {
  let n = 0
  const srv = await serve((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/to-meta') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end() }
    if (u.pathname === '/to-v6') { res.writeHead(307, { location: 'http://[::ffff:10.0.0.1]/' }); return res.end() }
    if (u.pathname === '/to-name') { res.writeHead(302, { location: `http://internal.fake-host.dev:${srv.port}/x` }); return res.end() }
    if (u.pathname === '/loop') { n++; res.writeHead(302, { location: '/loop' }); return res.end() }
    if (u.pathname === '/post302') { res.writeHead(302, { location: '/ok' }); return res.end() }
    res.writeHead(200); res.end('ok')
  })
  allowLocal({ 'internal.fake-host.dev': ['10.1.1.1'] })
  await assert.rejects(request({ url: srv.url('/to-meta'), policy: { mode: 'crawl' } }), (e) => e.code === 'private_ip')
  await assert.rejects(request({ url: srv.url('/to-v6'), policy: { mode: 'crawl' } }), (e) => e.code === 'private_ip')
  await assert.rejects(request({ url: srv.url('/to-name'), policy: { mode: 'crawl' } }), (e) => e.code === 'private_ip')
  await assert.rejects(request({ url: srv.url('/loop'), policy: { mode: 'crawl' } }), (e) => e.code === 'redirects')
  assert.equal(n, 4)
  await assert.rejects(request({ url: srv.url('/post302'), method: 'POST', body: '{}', noMethodChange: true, policy: { mode: 'crawl' } }), (e) => e.code === 'redirect_method')
  await srv.close(); resetNet()
})

test('size cap (after decompression) and total timeout', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/big') { res.writeHead(200); const chunk = Buffer.alloc(64 * 1024, 120); let i = 0; const w = () => { while (i++ < 64) if (!res.write(chunk)) return res.once('drain', w); res.end() }; return w() }
    if (req.url === '/slow') { res.writeHead(200); res.write('a'); return }   // never ends
    if (req.url === '/slow-gz') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.write(gzipSync(Buffer.from('x'.repeat(1000))).subarray(0, 20)); return }
    res.end('x')
  })
  allowLocal()
  await assert.rejects(request({ url: srv.url('/big'), policy: { mode: 'crawl' }, maxBytes: 2_000_000 }), (e) => e.code === 'too_large')
  const t = Date.now()
  await assert.rejects(request({ url: srv.url('/slow'), policy: { mode: 'crawl' }, timeoutMs: 400 }), (e) => e.code === 'timeout' || e.code === 'network')
  assert.ok(Date.now() - t < 3000)
  // a gzip body that stalls must end the reader too (no unsettled await)
  const t2 = Date.now()
  await assert.rejects(request({ url: srv.url('/slow-gz'), policy: { mode: 'crawl' }, timeoutMs: 400 }))
  assert.ok(Date.now() - t2 < 3000)
  await srv.close(); resetNet()
})

test('check mode refuses http and odd ports before any connection', async () => {
  allowLocal()
  await assert.rejects(request({ url: 'http://mcp.fake-host.dev/', policy: { mode: 'check' } }), (e) => e.code === 'scheme')
  await assert.rejects(request({ url: 'https://mcp.fake-host.dev:9999/', policy: { mode: 'check' } }), (e) => e.code === 'port')
  resetNet()
})
