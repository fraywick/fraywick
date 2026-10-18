// /server/:id (or /server/?id=): what we hold for one tracked server / skill / package, its timeline, current tools,
// and "verify in your browser" (proof from the API, leaf + root recomputed locally, verify() on Robinhood Chain).
import { h, nf, short, fmtUtc, epochDate, txUrl, arrow } from '/shared/site.js'
import { getServer, normChange, checkHref } from '/shared/api.js'
import { chip } from '/shared/checkbox.js'
import { visible, changeLine, changeDiffs, reasonsList, verifyInBrowser } from '/shared/ui.js'

const Q = new URLSearchParams(location.search)
const fromPath = location.pathname.replace(/^\/server\/?/, '').replace(/\/$/, '')
let id = Q.get('id') || (fromPath && fromPath !== 'index.html' ? fromPath : '')
try { id = decodeURIComponent(id) } catch {}
const title = document.getElementById('title'), body = document.getElementById('body')

function arr(x) { return Array.isArray(x) ? x : [] }
function schemaText(s) { return s == null ? '' : typeof s === 'string' ? s : JSON.stringify(s, null, 2) }

async function main() {
  if (!id) { title.textContent = 'No server given'; body.append(h('p', null, 'Open a server from the ', h('a', { href: '/feed/' }, 'feed'), ' or ', h('a', { href: '/check/' }, 'check'), ' one.')); return }
  title.textContent = ''
  title.append(visible(id))
  document.title = `${id} · FRAYWICK`
  let s
  try { s = await getServer(id) } catch (e) {
    body.append(h('p', { class: e.status === 404 ? 'muted' : 'err' }, e.status === 404 ? 'We do not track this item (yet). You can still hash it now: ' : 'The API is not reachable right now. ', e.status === 404 ? h('a', { href: checkHref(id) }, 'check it') : ''))
    return
  }
  s = s?.server ? { ...s.server, ...s } : s
  if (s?.registry) s = { ...s.registry, ...s }
  const parse = (b) => { if (typeof b !== 'string') return b || {}; try { return JSON.parse(b) } catch { return { description: b } } }
  const items = arr(s.items).filter((i) => i.removedEpoch == null).map((i) => ({ ...parse(i.body), ...i, description: parse(i.body).description ?? i.description, inputSchema: parse(i.body).inputSchema ?? i.inputSchema }))
  const byKind = (k) => items.filter((i) => (i.kind || 'tool') === k)
  const tools = arr(s.tools).length ? arr(s.tools) : byKind('tool')
  const prompts = arr(s.prompts).length ? arr(s.prompts) : byKind('prompt'), resources = arr(s.resources).length ? arr(s.resources) : byKind('resource')
  if (s.firstSeen == null && s.firstSeenEpoch == null && items.length) s.firstSeenEpoch = Math.min(...items.map((i) => i.firstEpoch ?? Infinity).filter(isFinite))
  const timeline = arr(s.timeline ?? s.changes ?? s.history).map(normChange).filter(Boolean).sort((a, b) => b.epoch - a.epoch)
  const leafKey = s.leafKey ?? s.leaf_key ?? s.key ?? s.id ?? id
  const lastEpoch = s.lastAnchoredEpoch ?? s.last_anchored_epoch ?? s.anchor?.epoch ?? null
  if (s.probe?.url && !arr(s.remotes).length) s.remotes = [{ type: s.probe.era || '', url: s.probe.url }]
  if (s.probe?.toolsHash && !s.hash) s.hash = s.probe.toolsHash
  const status = s.probe?.status ?? s.status ?? null
  const remotes = arr(s.remotes)

  if (s.title || s.description) body.append(h('p', { class: 'lede' }, s.title ? h('b', null, visible(s.title), '. ') : '', s.description ? visible(s.description) : ''))
  const latest = timeline.find((c) => c.label)
  body.append(h('div', { class: 'grid2' },
    h('div', { class: 'card' }, h('dl', { class: 'kv' },
      h('dt', null, 'kind'), h('dd', null, s.kind || '—'),
      h('dt', null, 'version'), h('dd', null, s.version ? visible(s.version) : '—'),
      status ? [h('dt', null, 'status'), h('dd', null, status === 'auth_required' ? 'login required: registry metadata only, tools not read' : visible(status))] : '',
      remotes.length ? [h('dt', null, 'remote'), h('dd', null, remotes.map((r) => h('div', null, visible(`${r.type || ''} ${r.url || ''}`.trim()))))] : '',
      h('dt', null, 'first seen'), h('dd', null, s.firstSeen || s.firstSeenEpoch != null ? fmtUtc(s.firstSeen || epochDate(s.firstSeenEpoch), { date: true }) : '—'),
      h('dt', null, 'leaf key'), h('dd', null, visible(leafKey)),
      s.hash ? [h('dt', null, 'tools hash'), h('dd', null, s.hash)] : '',
      s.probe?.at ? [h('dt', null, 'last read'), h('dd', null, `${fmtUtc(s.probe.at, { date: true })}${s.probe.protocolVersion ? ' · protocol ' + s.probe.protocolVersion : ''}`)] : '',
      h('dt', null, 'tools'), h('dd', null, `${nf(tools.length)}${prompts.length ? ` · ${nf(prompts.length)} prompts` : ''}${resources.length ? ` · ${nf(resources.length)} resources` : ''}`),
      latest ? [h('dt', null, 'last label'), h('dd', null, chip(latest.label), ` epoch ${nf(latest.epoch)}`)] : '')),
    verifyCard(leafKey, lastEpoch)))

  body.append(h('h2', { class: 'sec-h' }, 'Timeline'))
  if (!timeline.length) body.append(h('p', { class: 'muted' }, 'No changes since we first saw it.'))
  else {
    const ul = h('ul', { class: 'tl' })
    for (const c of timeline) {
      const li = changeLine(c, { link: false })
      if (c.label && c.change !== 'added') {
        const det = h('details', { class: 'raw' }, h('summary', null, 'diff and reasons'))
        det.addEventListener('toggle', () => { if (det.open && det.childElementCount === 1) det.append(reasonsList(c.reasons), ...changeDiffs(c).flat()) }, { once: false })
        li.append(det)
      }
      ul.append(li)
    }
    body.append(ul)
  }

  body.append(h('h2', { class: 'sec-h' }, `Current tools (${nf(tools.length)})`))
  if (!tools.length) body.append(h('p', { class: 'muted' }, status === 'auth_required' ? 'This server needs a login, so we only hold its registry metadata.' : 'No tools recorded.'))
  else {
    const tb = h('tbody')
    for (const t of tools) {
      const d = h('details', { class: 'raw' }, h('summary', null, 'description and schema'))
      d.addEventListener('toggle', () => { if (d.open && d.childElementCount === 1) d.append(h('pre', null, visible(t.description || '')), h('pre', null, visible(schemaText(t.inputSchema ?? t.input_schema)))) })
      tb.append(h('tr', null, h('td', { class: 'nw' }, h('b', null, visible(t.name || '—'))), h('td', null, h('div', { class: 'faint' }, t.hash ? short(t.hash, 8) : ''), d)))
    }
    body.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Tool'), h('th', null, 'Hash · definition'))), tb)))
  }
  body.append(h('p', { class: 'muted', style: 'margin-top:22px' }, 'All text above was fetched from a third party and is shown as plain text. ', h('a', { href: checkHref(s.url || remotes[0]?.url || id) }, 'Check it live now →')))
  void txUrl; void arrow
}

function verifyCard(leafKey, epoch) {
  const out = h('div', { class: 'verify-out' })
  const btn = h('button', { class: 'btn', type: 'button' }, 'Verify in your browser')
  btn.addEventListener('click', async () => { btn.disabled = true; btn.textContent = 'Verifying…'; await verifyInBrowser(leafKey, epoch, out); btn.disabled = false; btn.textContent = 'Verify again' })
  return h('div', { class: 'card' },
    h('h3', { style: 'margin-top:0' }, 'Verify in your browser'),
    h('p', { class: 'muted' }, 'Fetches the merkle proof for this item', epoch != null ? ` in epoch ${nf(epoch)}` : ' in the latest epoch', ', recomputes the leaf and the root here, then calls ', h('code', null, 'verify()'), ' on Robinhood Chain through a public RPC.'),
    h('div', { class: 'verify-box' }, btn), out)
}

main()
