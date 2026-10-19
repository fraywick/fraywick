// Landing: live data → the 3D tapestry (warp = tracked items, ridges = anchored hours, loose threads = changes),
// the 5-step scroll story, the ledger of woven rows, live numbers and the token tag.
import { h, nf, short, fmtUtc, epochDate, txUrl, arrow, copyButton, onConfig, token, site, launchAt, isAddr } from '/shared/site.js'
import { getItems, getAnchors, getFeed, getStats, getServer, serverHref } from '/shared/api.js'
import { mountCheck } from '/shared/checkbox.js'

const Q = new URLSearchParams(location.search)
const OG = Q.has('og'), POSTER = Q.has('poster')
if (OG) document.documentElement.classList.add('og')
if (POSTER) document.documentElement.classList.add('poster-mode')
const reduced = (matchMedia('(prefers-reduced-motion: reduce)').matches && !Q.has('motion')) || OG || POSTER
const $ = (s) => document.querySelector(s)
const canvas = $('#gl'), tagsEl = $('#tags'), story = $('#story')

// ── check box: live on first paint, before data or 3D ──
const form = $('#check')
mountCheck(form, $('#verdict'))
if (Q.get('t')) form.querySelector('input').value = Q.get('t')

const tierOf = () => (Q.has('low') ? 'low' : Q.has('high') ? 'high' : innerWidth < 760 || (navigator.hardwareConcurrency || 8) <= 4 ? 'low' : 'high')
const tier = tierOf()
const isMobile = () => innerWidth < 760

// ── state ──
let items = [], anchors = [], changes = [], groups = [], stats = null, tool = null
let scene = null, minis = null

const nextStamp = () => new Date((Math.floor((Date.now() / 1000 - 300) / 3600) + 1) * 3600e3 + 300e3)
const onChain = () => anchors.filter((a) => a.onChain !== false && a.tx)
const hashOf = (s) => { let x = 2166136261; for (const c of String(s)) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return ((x >>> 0) % 10000) / 10000 }
const VERB = { server: 'tool changed', skill: 'skill changed', package: 'package changed' }
const verbOf = (c) => (c.change === 'maintainer' ? 'maintainer changed' : c.change === 'added' ? 'added' : c.change === 'removed' ? 'removed' : VERB[c.kind] || 'changed')

async function load() {
  const [it, an, fd, st] = await Promise.allSettled([getItems(160), getAnchors(48), getFeed({ group: true, minLabel: 'behavior', limit: 60 }), getStats()])
  if (it.status === 'fulfilled' && it.value) items = it.value.items
  if (an.status === 'fulfilled') anchors = an.value.anchors.filter((a) => a.root && a.status !== 'skipped')
  if (fd.status === 'fulfilled') { groups = fd.value.groups || []; changes = fd.value.items }
  stats = st.status === 'fulfilled' ? st.value : null
}

// a real tool for step 1: the first tracked server that has tools
async function loadTool() {
  const cands = items.filter((i) => i.kind === 'server' && (i.raw?.toolCount ?? 1) > 0).slice(0, 6)
  for (const c of cands) {
    try {
      const s = await getServer(c.id)
      const list = (s.items || s.tools || []).filter((i) => (i.kind || 'tool') === 'tool' && i.removedEpoch == null)
      const t = list.find((i) => i.body?.description || i.description) || list[0]
      if (t) return { server: c.id, name: t.name || t.body?.name, description: t.body?.description || t.description || '', hash: t.hash }
    } catch {}
  }
  return null
}

// ── data → scene ──
function looseList() {
  const cap = tier === 'low' ? 4 : 7
  const ridgeOf = new Map(onChain().slice(0, 9).map((a, k) => [a.epoch, k]))
  const colOf = new Map(items.map((t, i) => [t.id, i]))
  const seen = new Set(), out = []
  for (const g of groups) {
    if (!g.subject || seen.has(g.subject) || !['behavior', 'suspicious'].includes(g.label)) continue
    seen.add(g.subject)
    const c = g.changes.find((x) => x.label === g.label) || g.changes[0]
    if (!c) continue
    const col = colOf.get(g.subject)
    const u = 0.08 + 0.84 * (col != null && items.length ? (col + 0.5) / items.length : hashOf(g.subject))
    const k = ridgeOf.get(g.epoch)
    const v = k != null ? 0.12 + k * 0.098 + 0.045 : 0.06 + hashOf(g.subject + 'v') * 0.03
    out.push({ u, v: Math.min(0.9, v), label: g.label, change: { ...c, itemId: g.subject, count: g.count }, short: short(c.newHash || '', 3) })
    if (out.length >= cap) break
  }
  // spread threads across the width (ordered by their own hash) so neighbours never overlap
  const order = out.map((o, i) => [hashOf(o.change.itemId), i]).sort((a, b) => a[0] - b[0])
  order.forEach(([hh, i], rank) => { out[i].u = 0.12 + 0.76 * ((rank + 0.5) / out.length) + (hh - 0.5) * 0.04; out[i].v = Math.min(0.9, out[i].v + (rank % 3) * 0.022) })
  return out
}
function pushData() {
  if (!scene) return
  const tracked = stats ? (stats.readable || 0) + (stats.skills || 0) + (stats.packages || 0) : items.length
  scene.setWarp(Math.min(tier === 'low' ? 60 : 90, Math.max(items.length, tracked || 0) || 90))
  scene.setRidges(onChain().length)
  scene.setLoose(looseList())
  buildTags()
  const top = anchors[0], chained = onChain()[0]
  scene.setStoryData({
    hash: tool?.hash || null, root: top?.root || null, leafCount: top?.leafCount ?? null,
    epoch: chained ? nf(chained.epoch) : null, tx: chained?.tx || null, nextStamp: fmtUtc(nextStamp()),
  })
  $('.legend .drag').hidden = !scene.loose.length
}

// ── evidence labels next to the 3D tags ──
let tags = [], hoverL = null
function buildTags() {
  tagsEl.textContent = ''
  tags = (scene?.loose || []).map((l) => {
    const c = l.change
    const el = h('a', { class: `tag ${l.label}`, href: `/change/?id=${c.raw?.id}`, title: `${c.name || c.itemId}${c.tool ? ' · ' + c.tool : ''} · ${c.label}${c.score != null ? ' ' + c.score + '/100' : ''}` },
      isMobile() ? `${verbOf(c).replace(' changed', '')} · ${fmtUtc(epochDate(c.epoch)).replace(' UTC', '')}` : `${verbOf(c)} · ${fmtUtc(epochDate(c.epoch))} · ${short(c.newHash || '', 2).replace(/….*$/, '…')}`)
    tagsEl.append(el)
    return { el, l, w: 0 }
  })
}
let storyP = -1
function placeTags() {
  const show = storyP < -0.35 && !OG && !POSTER
  const placed = []
  for (const t of tags) {
    const p = scene.tagScreen(t.l)
    const on = show && p.z < 1 && p.y > 70 && p.y < innerHeight - 30 && (t.l === hoverL || tags.indexOf(t) < (isMobile() ? 1 : 4))
    if (on && !t.w) t.w = t.el.offsetWidth
    let x = p.x + 18, y = p.y - 2
    if (x + t.w > innerWidth - 8) x = p.x - t.w - 18
    for (const o of placed) if (Math.abs(o.y - y) < 27 && Math.abs(o.x - x) < Math.max(o.w, t.w)) y = o.y + 28
    if (on) placed.push({ x, y, w: t.w })
    t.el.classList.toggle('on', on)
    t.el.tabIndex = on ? 0 : -1
    t.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  }
}

// ── scroll story ──
const stepEls = [...document.querySelectorAll('.story .step')], dots = [...document.querySelectorAll('.story .dots i')]
function onScroll() {
  if (OG || POSTER) { storyP = -1; scene?.setStory(-1); return }
  const vh = innerHeight
  storyP = (scrollY - story.offsetTop) / vh
  scene?.setStory(storyP)
  const active = storyP >= -0.12 && storyP < 5 ? Math.max(1, Math.min(5, Math.floor(storyP) + 1)) : 0
  stepEls.forEach((e, i) => e.classList.toggle('on', i + 1 === active))
  dots.forEach((d, i) => d.classList.toggle('on', i + 1 <= active))
  const end = story.offsetTop + story.offsetHeight - vh
  const fade = Math.max(0, Math.min(1, (scrollY - end) / (vh * 0.45)))
  canvas.style.opacity = String(1 - fade)
  scene?.setVisible(fade < 1)
  if (storyP >= -0.35) for (const t of tags) t.el.classList.remove('on')
}
addEventListener('scroll', onScroll, { passive: true })

function fillStory() {
  const set = (k, ...kids) => { const e = document.querySelector(`[data-${k}]`); e.textContent = ''; e.append(...kids) }
  if (tool) {
    const desc = String(tool.description || '').replace(/\s+/g, ' ').trim()
    set('s1', h('p', null, h('span', { class: 'mono' }, tool.name || 'tool'), ' from ', h('a', { href: serverHref(tool.server) }, tool.server)),
      desc ? h('p', { class: 'quote' }, `"${desc.length > 190 ? desc.slice(0, 190) + '…' : desc}"`) : '',
      h('p', null, 'This text is what an agent reads before it calls the tool. If it changes, the agent behaves differently.'))
    set('s2', h('p', null, 'Name, title, description, input and output schema and annotations, in RFC 8785 canonical JSON, hashed:'),
      h('p', { class: 'big' }, tool.hash || '—'), h('p', null, 'One changed character gives a completely different hash.'))
  } else {
    set('s1', h('p', null, 'No tool has been read yet. The crawler reads every public remote server once an hour; the first tool appears here when it lands.'))
    set('s2', h('p', null, 'Each tool definition becomes ', h('code', null, 'keccak256(JCS(tool))'), '. The first real hash appears here after the first crawl.'))
  }
  const top = anchors[0]
  if (top) set('s3', h('p', null, `${nf(top.leafCount)} leaves (one per server, skill and package) in epoch ${nf(top.epoch)}, ${fmtUtc(epochDate(top.epoch), { date: true })}, braided into:`), h('p', { class: 'big' }, top.root),
    h('p', null, h('a', { href: `/proof/#e${top.epoch}` }, 'Rebuild it in your browser →')))
  else set('s3', h('p', null, 'All leaves of the hour go into one StandardMerkleTree. The first root of the hour is built at :05.'))
  const ch = onChain()[0]
  if (ch) set('s4', h('p', null, `Epoch ${nf(ch.epoch)} was posted to the ToolAnchor contract`, ch.postedAt ? ` at ${fmtUtc(ch.postedAt)}` : '', '.'),
    h('p', { class: 'big' }, h('a', { href: txUrl(ch.tx), target: '_blank', rel: 'noopener' }, short(ch.tx, 10), arrow())),
    h('p', null, 'Anyone can read ', h('code', null, `anchors(${ch.epoch})`), ' and check a proof with ', h('code', null, 'verify()'), '.'))
  else set('s4', h('p', null, top ? `The root of epoch ${nf(top.epoch)} is built but not on chain yet.` : 'No hour is on chain yet.'), h('p', { class: 'big' }, `next stamp at ${fmtUtc(nextStamp())}`))
  const n = onChain().length
  set('s5', h('p', null, n ? `${nf(n)} hour${n > 1 ? 's' : ''} woven into the chain so far. Each raised ridge on the tapestry is one of them.` : 'The first ridge is woven when the first root lands on chain.'),
    h('p', null, 'When a definition changes after people trusted it, its thread pulls loose, with the diff and the proof of when.'))
}

// ── a real change, proven (picked from live data at runtime) ──
let provenId = null
async function renderProven() {
  const sec = $('#proven'), box = $('#proven-card')
  const chained = onChain()
  const pick = changes.find((c) => c.change === 'changed' && ['tool', 'prompt', 'resource'].includes(c.itemKind) && c.anchorEpoch != null && chained.some((a) => a.epoch === c.anchorEpoch) && chained.some((a) => a.epoch < c.anchorEpoch))
  if (!pick) { sec.hidden = true; return }
  if (provenId === pick.raw.id) return
  provenId = pick.raw.id
  sec.hidden = false
  const { proveSide, itemName, stepList, addStep } = await import('/shared/proofkit.js')
  const name = itemName(pick.rawItem, pick.itemId)
  const oldA = chained.find((a) => a.epoch < pick.anchorEpoch), newA = chained.find((a) => a.epoch === pick.anchorEpoch)
  box.textContent = ''
  const verdict = h('p', { class: 'pv-verdict' }, 'Checking both hashes against Robinhood Chain in your browser…')
  box.append(h('p', { class: 'pv-k' }, `${pick.itemKind} `, h('b', null, name), ' on ', h('a', { href: serverHref(pick.itemId) }, pick.itemId)),
    h('p', { class: 'pv-r' }, h('span', { class: `chip ${pick.label}` }, pick.label), ` ${pick.reasons.map((r) => r.text).slice(0, 2).join(' · ')}`), verdict)
  const cols = h('div', { class: 'pv-cols' })
  box.append(cols, h('a', { class: 'pv-more', href: `/change/?id=${pick.raw.id}` }, 'See the diff and every step →'))
  const run = (label, a, hash) => {
    const ul = stepList()
    cols.append(h('div', { class: 'pv-col' }, h('p', { class: 'pv-h' }, `${label} · epoch ${nf(a.epoch)}`), h('p', { class: 'pv-hash' }, hash), ul))
    return proveSide({ subject: pick.itemId, kind: pick.itemKind, name, hash, epoch: a.epoch, tx: a.tx }, (st) => addStep(ul, st))
  }
  const [r1, r2] = await Promise.all([run('before', oldA, pick.oldHash), run('after', newA, pick.newHash)])
  verdict.textContent = ''
  verdict.append(r1.ok && r2.ok ? h('b', { class: 'ok' }, '✓ Both versions proven on chain, checked in your browser just now.') : h('b', { class: 'bad' }, 'Not every step passed; see the details.'))
}

// ── ledger ──
function renderLedger() {
  const ol = $('#rows'); ol.textContent = ''
  minis?.clearStrips()
  const add = (cls, seed, day, ...info) => {
    const strip = h('div', { class: 'strip' })
    ol.append(h('li', { class: `row ${cls}` }, strip, h('div', { class: 'info' }, ...info)))
    minis?.strip(strip, { seed, day, warp: 96 })
  }
  add('pending', 0.3, false, h('span', { class: 'ep' }, 'now · weaving the next hour'), h('span', { class: 'meta' }, `next stamp ≈ ${fmtUtc(nextStamp())}`))
  const perEpoch = new Map()
  for (const c of changes) { if (!perEpoch.has(c.epoch)) perEpoch.set(c.epoch, []); perEpoch.get(c.epoch).push(c) }
  for (const a of anchors.slice(0, 24)) {
    const ch = perEpoch.get(a.epoch) || []
    const shown = ch.filter((c) => c.label && c.label !== 'cosmetic').slice(0, 2)
    const rest = ch.length - shown.length
    add('', a.epoch * 0.37, a.epoch % 24 === 0,
      h('span', { class: 'ep', id: `e${a.epoch}` }, `epoch ${nf(a.epoch)} · ${fmtUtc(epochDate(a.epoch), { date: true })}`),
      h('span', { class: 'meta' }, 'root ', h('a', { href: `/proof/#e${a.epoch}` }, short(a.root, 6)), ` · ${nf(a.leafCount)} leaves · `,
        a.tx && a.onChain !== false ? h('a', { href: txUrl(a.tx), target: '_blank', rel: 'noopener' }, 'tx', arrow()) : a.status === 'dry' ? 'dry run, not posted' : a.status === 'sent' ? 'posting' : a.status === 'failed' ? 'post failed, retrying' : 'not on chain yet'),
      ch.length ? h('span', { class: 'chg' }, shown.map((c) => h('a', { href: serverHref(c.itemId) }, h('span', { class: `chip ${c.label}` }, c.label), h('span', { class: 'n' }, c.name || c.itemId))),
        rest > 0 ? h('a', { href: `/feed/?epoch=${a.epoch}` }, `${shown.length ? '+' : ''}${rest} change${rest > 1 ? 's' : ''}`) : '') : h('span', { class: 'meta' }, 'no changes this hour'))
  }
  const end = $('#rows-end'); end.textContent = ''
  end.append(anchors.length ? `The last ${nf(Math.min(24, anchors.length))} hours. Every anchored hour: ` : 'No hour has been anchored yet. The first one appears here after :05. ', h('a', { href: '/proof/' }, 'Proof →'))
}

// ── live numbers + how it works ──
function renderLive() {
  const live = $('#live'), txt = live.querySelector('.txt')
  txt.textContent = ''
  if (!stats) { live.classList.remove('ok'); txt.append('The watchtower API is not reachable right now.'); return }
  live.classList.add('ok')
  const a = onChain()[0]
  txt.append(`Watching ${nf(stats.readable ?? stats.servers)} servers · ${nf(stats.tools)} tools · ${nf(stats.skills)} skills · ${nf(stats.packages)} packages (from our own crawl; per-hour counts are in each anchored snapshot). `)
  if (a) txt.append(h('span', null, 'Last stamp: ', h('a', { href: `/proof/#e${a.epoch}` }, `epoch ${nf(a.epoch)}`), ` · ${fmtUtc(a.postedAt || epochDate(a.epoch))} · `, h('a', { href: txUrl(a.tx), target: '_blank', rel: 'noopener' }, 'tx', arrow())))
  else txt.append(`No hour on chain yet; next stamp ${fmtUtc(nextStamp())}.`)
  const set = (k, ...kids) => { const e = document.querySelector(`[data-stat="${k}"]`); if (e) { e.textContent = ''; e.append(...kids) } }
  set('read', `Now: ${nf(stats.readable ?? stats.servers)} readable servers of ${nf(stats.servers)} in the registry, ${nf(stats.skills)} skills, ${nf(stats.packages)} packages${stats.authRequired ? ` (${nf(stats.authRequired)} need a login: metadata only)` : ''}.`)
  set('hash', `Now: ${nf(stats.tools)} tools hashed. ${stats.changes24h != null ? `${nf(stats.changes24h)} changes in the last 24 h, ${nf(stats.suspicious24h)} suspicious.` : ''}`)
  const top = anchors[0]
  if (top) set('stamp', h('span', null, 'Latest root: epoch ', h('a', { href: `/proof/#e${top.epoch}` }, nf(top.epoch)), `, ${nf(top.leafCount)} leaves, ${short(top.root, 6)}`, a ? [', last on-chain ', h('a', { href: txUrl(a.tx), target: '_blank', rel: 'noopener' }, 'tx', arrow())] : '', '.'))
}

// ── token tag ──
onConfig(() => {
  const cc = $('#ca-copy'); cc.textContent = ''; cc.append(copyButton(() => token.ca, 'Copy contract address'))
  $('#ca-note').hidden = isAddr(token.ca)
  const at = launchAt()
  $('#launch-at').textContent = at ? fmtUtc(at, { date: true }) : ''
  document.querySelectorAll('[data-cli]').forEach((e) => (e.hidden = !site.cli))
})

// ── pointer: parallax, wind gust, pull loose threads, ripple the cloth ──
function bindPointer() {
  let down = null, last = null
  canvas.addEventListener('pointerdown', (e) => {
    if (!scene || storyP > -0.4) return
    const hit = scene.pickLoose(e.clientX, e.clientY, e.pointerType === 'touch' ? 30 : 20)
    if (hit) { scene.grab(hit.i); hoverL = hit.l }
    else if (e.pointerType === 'touch' || !scene.grabCloth(e.clientX, e.clientY)) return
    down = { x: e.clientX, y: e.clientY, hit, moved: 0 }
    canvas.setPointerCapture(e.pointerId); canvas.classList.add('grabbing')
  })
  canvas.addEventListener('touchstart', (e) => { if (scene && storyP < -0.4 && scene.pickLoose(e.touches[0].clientX, e.touches[0].clientY, 30)) e.preventDefault() }, { passive: false })
  const up = () => {
    if (!down) return
    scene.release(); canvas.classList.remove('grabbing')
    if (down.hit && down.moved < 6) location.href = `/change/?id=${down.hit.l.change.raw?.id}`
    down = null
  }
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', () => { down = null; scene?.release(); canvas.classList.remove('grabbing') })
  addEventListener('pointermove', (e) => {
    if (!scene) return
    scene.pointer(e.clientX, e.clientY)
    if (down) { down.moved = Math.max(down.moved, Math.hypot(e.clientX - down.x, e.clientY - down.y)); scene.drag(e.clientX, e.clientY); return }
    if (e.pointerType !== 'mouse' || e.target !== canvas) { last = null; return }
    const t = performance.now()
    const hit = scene.pickLoose(e.clientX, e.clientY, 16)
    hoverL = hit ? hit.l : null
    canvas.classList.toggle('grab', !!hit)
    if (last) scene.gustAt(e.clientX, e.clientY, ((e.clientX - last.x) / Math.max(8, t - last.t)) * 1000)
    last = { x: e.clientX, y: e.clientY, t }
  })
}

// ── boot ──
function fallback(why) {
  console.warn('tapestry fallback:', why)
  scene?.dispose?.(); scene = null
  canvas.hidden = true
  $('#poster').hidden = false
  document.documentElement.classList.add('nogl', 'ready')
}
async function boot() {
  const dataP = load()
  try {
    if (Q.has('nogl') || !document.createElement('canvas').getContext('webgl2')) throw new Error('no webgl2')
    const { createScene } = await import('./scene3d.js')
    scene = createScene(canvas, { tier, reduced, blankTags: OG || POSTER, onFrame: placeTags })
    scene.layout(innerWidth, innerHeight, isMobile())
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fallback('context lost') }, { once: true })
    bindPointer()
    scene.start()
    document.documentElement.classList.add('ready')
  } catch (e) { fallback(e.message) }
  if (!OG && !POSTER) {
    try {
      const { createMinis } = await import('./minis.js')
      minis = canvas.hidden ? null : createMinis($('#minis'))
      if (minis) { minis.tag($('#tag3d')); minis.start() } else document.documentElement.classList.add('no-minis')
    } catch { document.documentElement.classList.add('no-minis') }
  }
  await dataP
  renderLive(); renderLedger(); fillStory(); pushData(); onScroll(); renderProven()
  if (OG || POSTER) { scene?.settle(200); scene?.renderOnce(); document.documentElement.classList.add('shot-ready') }
  tool = await loadTool()
  fillStory(); if (scene) pushData()
}
boot()

let rT
addEventListener('resize', () => {
  clearTimeout(rT)
  rT = setTimeout(() => { scene?.layout(innerWidth, innerHeight, isMobile()); buildTags(); onScroll() }, 120)
})
setInterval(async () => {
  const key = () => `${anchors[0]?.epoch}|${changes[0]?.id}|${onChain().length}`
  const before = key()
  await load()
  renderLive()
  if (key() !== before) { renderLedger(); fillStory(); pushData(); renderProven() }
}, 60000)

window.__fw = { get scene() { return scene }, get data() { return { items, anchors, changes, stats, tool } } }
