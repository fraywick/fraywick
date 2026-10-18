// FRAYWICK shared chrome + config: top bar, drawer, footer, toast, clipboard, formatting, safe DOM builder.
// Links read /site.json (domain, x, telegram, github, anchor_address, explorer) and /token.json (ca, symbol, launch_at, pons_token_url).
// A link whose value is null stays hidden. The ticker is never written in code: [data-symbol] shows token.symbol only when set.

export const ZERO = '0x0000000000000000000000000000000000000000'
export const PONS_HOME = 'https://www.ponsfamily.com'

export const site = { domain: null, x: null, telegram: null, github: null, anchor_address: null, explorer: 'https://robinhoodchain.blockscout.com' }
export const token = { ca: ZERO, symbol: null, decimals: 18, launch_at: null, pons_token_url: null }
let loaded = false
const waiters = []
export function onConfig(fn) { waiters.push(fn); if (loaded) fn(site, token) }

export const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '') && String(a).toLowerCase() !== ZERO
export const isLive = () => isAddr(token.ca)
export const explorer = () => (site.explorer || 'https://robinhoodchain.blockscout.com').replace(/\/+$/, '')
export const txUrl = (h) => `${explorer()}/tx/${h}`
export const addrUrl = (a) => `${explorer()}/address/${a}`
export const short = (h, n = 4) => (h ? (String(h).length > 2 * n + 4 ? `${String(h).slice(0, 2 + n)}…${String(h).slice(-n)}` : String(h)) : '')
export const origin = () => (site.domain ? `https://${String(site.domain).replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : location.origin)

// ── safe DOM builder: strings become text nodes, never HTML ──────────────
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag)
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'text') el.textContent = v
    else if (k === 'html') el.innerHTML = v // own static markup only (icons)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c))
  return el
}

// ── time / numbers ───────────────────────────────────────────────────────
export const nf = (v) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US'))
export const epochDate = (e) => new Date(Number(e) * 3600e3)
const p2 = (v) => String(v).padStart(2, '0')
export function fmtUtc(d, opts = {}) {
  d = d instanceof Date ? d : new Date(d)
  if (isNaN(d)) return '—'
  const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
  if (!opts.date) return `${hm} UTC`
  const day = d.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
  return `${day} · ${hm} UTC`
}
export function fmtAgo(d) {
  const s = Math.round((Date.now() - new Date(d)) / 1000)
  if (!isFinite(s)) return ''
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172800) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400), hh = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, x = s % 60
  return (d > 0 ? `${d}d ` : '') + `${p2(hh)}:${p2(m)}:${p2(x)}`
}

// ── icons (own markup) ───────────────────────────────────────────────────
export const ICON = {
  x: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.7 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.2-8.3L1.8 3h6.4l4.4 5.8zm-1.1 16.2h1.7L7.5 4.7H5.7z"/></svg>',
  tg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.6 4.4 18.4 19.5c-.2 1-.9 1.3-1.8.8l-4.8-3.6-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.4-.1-.5-.6-.2L6.1 13.2l-4.8-1.5c-1-.3-1-1 .2-1.5L20.2 2.9c.9-.3 1.6.2 1.4 1.5z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  // mark: four warp threads, the third one frays out in safety orange
  logo: '<svg viewBox="0 0 32 32" aria-hidden="true"><g stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 4v24M13 4v24M25 4v24"/><path d="M19 4v11"/></g><path d="M19 15c0 4 3 5 3 8s-3 3-5 5" fill="none" stroke="#ff5a1f" stroke-width="2.4" stroke-linecap="round"/></svg>',
}
export const arrow = () => h('span', { class: 'ext', html: ICON.arrow })

// ── toast + clipboard ────────────────────────────────────────────────────
let toastEl, toastT
export function toast(msg, ms = 2600) {
  if (!toastEl) { toastEl = h('div', { class: 'toast', role: 'status' }); document.body.append(toastEl) }
  toastEl.textContent = msg
  toastEl.classList.add('show')
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms)
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text })
    ta.style.cssText = 'position:fixed;opacity:0;left:0;top:0'
    document.body.append(ta); ta.select()
    let ok = false; try { ok = document.execCommand('copy') } catch {}
    ta.remove(); return ok
  }
}
export function copyButton(getText, label = 'Copy') {
  const b = h('button', { class: 'copy', type: 'button', 'aria-label': label, html: ICON.copy })
  b.addEventListener('click', async () => {
    const t = getText(); if (!t) return
    if (await copyText(t)) { b.innerHTML = ICON.check; toast('Copied.'); setTimeout(() => (b.innerHTML = ICON.copy), 1400) }
  })
  return b
}

// ── bar ──────────────────────────────────────────────────────────────────
const LINKS = [['/feed/', 'Feed'], ['/check/', 'Check'], ['/proof/', 'Proof'], ['/docs/', 'Docs']]
let timerEls = []

function renderBar(el) {
  const here = location.pathname.replace(/index\.html$/, '')
  el.classList.add('bar')
  const link = ([href, l]) => `<a class="nl" href="${href}"${here.startsWith(href) ? ' aria-current="page"' : ''}>${l}</a>`
  el.innerHTML = `
    <a class="wordmark" href="/" aria-label="FRAYWICK home">${ICON.logo}<span>FRAYWICK</span></a>
    <span class="bar-timer" data-timer hidden></span>
    <span class="bar-gap"></span>
    <nav class="bar-links" aria-label="Main">${LINKS.map(link).join('')}
      <a class="nl" data-link="x" target="_blank" rel="noopener" hidden>X</a>
      <a class="nl" data-link="telegram" target="_blank" rel="noopener" hidden>Telegram</a>
    </nav>
    <a class="btn buy" data-buy target="_blank" rel="noopener">Buy on Pons</a>
    <button class="burger" type="button" aria-label="Open menu" aria-expanded="false">${ICON.menu}</button>`
  const drawer = h('nav', { class: 'drawer', 'aria-label': 'Menu' })
  drawer.innerHTML = `${LINKS.map(link).join('')}
    <a class="nl" data-link="x" target="_blank" rel="noopener" hidden>X</a>
    <a class="nl" data-link="telegram" target="_blank" rel="noopener" hidden>Telegram</a>
    <span class="bar-timer" data-timer hidden></span>`
  el.after(drawer)
  const burger = el.querySelector('.burger')
  const setOpen = (open) => {
    drawer.classList.toggle('open', open)
    burger.setAttribute('aria-expanded', String(open)); burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
    burger.innerHTML = open ? ICON.close : ICON.menu
  }
  burger.addEventListener('click', () => setOpen(!drawer.classList.contains('open')))
  drawer.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false) })
  addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false) })
  timerEls = [...document.querySelectorAll('[data-timer]')]
}

export function launchAt() { const d = token.launch_at ? new Date(token.launch_at) : null; return d && !isNaN(d) ? d : null }
function tick() {
  const at = launchAt()
  const ms = at ? at - Date.now() : -1
  for (const t of timerEls) {
    if (ms <= 0) { t.hidden = true; continue }
    t.hidden = false
    t.textContent = ''
    t.append(h('span', { class: 'k' }, 'launch in'), h('b', null, fmtDur(ms)))
  }
  document.querySelectorAll('[data-countdown]').forEach((e) => {
    e.textContent = ms > 0 ? fmtDur(ms) : 'live'
  })
}

// ── footer ───────────────────────────────────────────────────────────────
function renderFoot(el) {
  el.classList.add('foot')
  el.innerHTML = `<div class="in">
    <a class="wordmark" href="/">${ICON.logo}<span>FRAYWICK</span></a>
    <nav aria-label="Footer"><a href="/feed/">Feed</a><a href="/check/">Check</a><a href="/proof/">Proof</a><a href="/docs/">Docs</a><a href="/docs/#bot">Bot policy</a>
      <a data-link="x" target="_blank" rel="noopener" hidden>X</a><a data-link="telegram" target="_blank" rel="noopener" hidden>Telegram</a><a data-link="github" target="_blank" rel="noopener" hidden>GitHub</a></nav>
    <p class="legal">FRAYWICK reads public tool definitions and stamps their hashes on Robinhood Chain. It routes nothing, hosts nothing and runs no third-party code. Labels describe a diff, not a person or a project. Not affiliated with Anthropic, the MCP project, Robinhood or any listed server. Nothing here is financial advice.</p>
  </div>`
}

// ── bindings ─────────────────────────────────────────────────────────────
export function applyLinks(root = document) {
  root.querySelectorAll('[data-link]').forEach((a) => {
    const v = site[a.dataset.link]
    if (v) { a.href = v; a.hidden = false } else { a.removeAttribute('href'); a.hidden = true }
  })
  root.querySelectorAll('[data-buy]').forEach((a) => (a.href = token.pons_token_url || PONS_HOME))
  root.querySelectorAll('[data-symbol]').forEach((e) => {
    if (token.symbol) { e.textContent = '$' + token.symbol; e.hidden = false } else { e.textContent = ''; e.hidden = true }
  })
  root.querySelectorAll('[data-ca]').forEach((e) => (e.textContent = token.ca || ZERO))
  root.querySelectorAll('[data-anchor]').forEach((e) => {
    const a = site.anchor_address
    if (isAddr(a)) { e.textContent = a; if (e.tagName === 'A') e.href = addrUrl(a); e.closest('[data-anchor-wrap]')?.removeAttribute('hidden') }
  })
  root.querySelectorAll('[data-origin]').forEach((e) => (e.textContent = origin()))
}

async function loadJson(url) {
  try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) return await r.json() } catch {}
  return null
}
async function loadConfig() {
  const [s, t] = await Promise.all([loadJson('/site.json'), loadJson('/token.json')])
  if (s) Object.assign(site, s)
  if (t) Object.assign(token, t)
  loaded = true
  applyLinks(); tick()
  document.documentElement.classList.toggle('token-live', isLive())
  waiters.forEach((fn) => { try { fn(site, token) } catch (e) { console.error(e) } })
}

function boot() {
  const bar = document.getElementById('bar'); if (bar) renderBar(bar)
  const foot = document.getElementById('foot'); if (foot) renderFoot(foot)
  applyLinks()
  loadConfig()
  setInterval(tick, 1000)
  // token.json flips at go-live without a reload
  setInterval(async () => {
    const t = await loadJson('/token.json')
    if (t && (t.ca !== token.ca || t.symbol !== token.symbol || t.pons_token_url !== token.pons_token_url)) {
      Object.assign(token, t); applyLinks(); tick(); waiters.forEach((fn) => { try { fn(site, token) } catch {} })
    }
  }, 60000)
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
else boot()
