// FRAYWICK server entry. ROLE=api (HTTP API + /mcp), ROLE=crawler (registry sync, probes, epochs, poster), ROLE=all (default, local dev).
// Production runs two units from this file: fraywick-api.service (ROLE=api) and fraywick-crawler.service (ROLE=crawler); both share
// the SQLite file (WAL). Env: see config.mjs. SERVE_WEB=1 serves ../web (or server/dev-web when web/ is missing) for local testing.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openStore } from './store.mjs'
import { createApi } from './api.mjs'
import { createChain } from './chain.mjs'
import { createRunner } from './runner.mjs'
import { mode, anchorConfig, dryPost, publicUrl, userAgent } from './config.mjs'

const ROLE = process.env.ROLE || 'all'
const PORT = Number(process.env.PORT || 4891)
const store = openStore()
const chain = createChain()
const WEB_REAL = fileURLToPath(new URL('../web/', import.meta.url))
const WEB = existsSync(join(WEB_REAL, 'index.html')) ? WEB_REAL : fileURLToPath(new URL('./dev-web/', import.meta.url))

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.glb': 'model/gltf-binary' }

let server = null
if (ROLE === 'api' || ROLE === 'all') {
  const api = createApi({ store, chain })
  server = createServer(async (req, res) => {
    try {
      if (await api(req, res)) return
      if (process.env.SERVE_WEB === '1' && (req.method === 'GET' || req.method === 'HEAD')) {
        let f = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
        if (/(^|\/)\./.test(f)) throw Object.assign(new Error('dotfile'), { code: 'ENOENT' })
        if (f.endsWith('/')) f += 'index.html'
        let full = join(WEB, f)
        if (!full.startsWith(WEB)) throw Object.assign(new Error('outside'), { code: 'ENOENT' })
        try { if ((await stat(full)).isDirectory()) full = join(full, 'index.html') } catch { if (!extname(full)) full += '.html' }
        const data = await readFile(full)
        res.writeHead(200, { 'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
        return res.end(req.method === 'HEAD' ? undefined : data)
      }
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}')
    } catch (e) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(e.code)) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found"}') }
      console.error(req.url, e)
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"server error"}') }
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.listen(PORT, process.env.BIND || undefined, () => {
    console.log(`fraywick api on :${PORT} · ${mode()} · anchor ${anchorConfig().address || 'not deployed yet'} · ${publicUrl() || 'no PUBLIC_URL'}${process.env.SERVE_WEB === '1' ? ` · serving ${WEB}` : ''}`)
  })
}

let runner = null
if (ROLE === 'crawler' || ROLE === 'all') {
  runner = createRunner({ store, chain })
  console.log(`fraywick crawler · ${dryPost() ? 'DRY_POST (nothing is sent)' : `posting as ${chain.posterAddress() || '— no poster key'}`} · anchor ${anchorConfig().address || 'not deployed yet'} · UA "${userAgent()}"`)
  runner.start()
}

const stop = () => { runner?.stop(); server?.close(); try { store.close() } catch {} process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
