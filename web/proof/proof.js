// /proof: every anchored hour + "recompute this root" (snapshot → leaf hashes → StandardMerkleTree → compare with chain).
import { h, nf, short, fmtUtc, epochDate, txUrl, addrUrl, arrow, site, onConfig, copyButton, explorer } from '/shared/site.js'
import { getAnchors, getHealth, getSnapshot } from '/shared/api.js'
import { leafHash, merkleRoot, snapshotLeaves, chainAnchor, chainLatestEpoch } from '/shared/chain.js'
import { anchorAddress } from '/shared/ui.js'

const tbody = document.querySelector('#tbl tbody'), state = document.getElementById('state'), contract = document.getElementById('contract')
let apiContract = null

async function recompute(a, out, btn) {
  btn.disabled = true
  out.textContent = ''
  const steps = h('ul', { class: 'steps-out' })
  out.append(steps)
  const step = (cls, ...k) => steps.append(h('li', { class: cls }, ...k))
  try {
    const t0 = performance.now()
    const snap = await getSnapshot(a)
    const leaves = snapshotLeaves(snap)
    if (!leaves.length) { step('bad', 'Snapshot has no leaves we can read.'); return }
    step('ok', `Snapshot downloaded: ${nf(leaves.length)} leaves${snap.format ? ` (${snap.format})` : ''}.`)
    await new Promise((r) => setTimeout(r))
    const hashes = leaves.map(leafHash)
    const listed = (snap.leaves || []).map((l) => l.h || l.hash).filter(Boolean)
    if (listed.length === hashes.length) {
      const bad = hashes.filter((x, i) => x !== listed[i]).length
      step(bad ? 'bad' : 'ok', bad ? `${nf(bad)} leaf hashes in the file do not match their values.` : 'Every leaf hash in the file matches its values.')
    }
    const root = merkleRoot(hashes)
    step(root === a.root ? 'ok' : 'bad', `Root rebuilt in your browser in ${Math.round(performance.now() - t0)} ms: ${short(root, 8)} ${root === a.root ? '= API root' : '≠ API root ' + short(a.root, 8)}`)
    if (a.leafCount != null && a.leafCount !== leaves.length) step('bad', `Leaf count ${nf(leaves.length)} ≠ ${nf(a.leafCount)} reported.`)
    const addr = anchorAddress(apiContract)
    if (!addr) { step('', 'ToolAnchor address not configured on this site: on-chain comparison skipped.'); return }
    const c = await chainAnchor(addr, a.epoch)
    if (!c || /^0x0+$/.test(c.root)) { step('bad', `anchors(${nf(a.epoch)}) is empty on chain.`); return }
    step(c.root.toLowerCase() === root.toLowerCase() ? 'ok' : 'bad', `anchors(${nf(a.epoch)}) on Robinhood Chain = ${short(c.root, 8)}, ${nf(c.leafCount)} leaves, posted ${fmtUtc(new Date(c.postedAt * 1000), { date: true })}`)
    out.prepend(h('p', null, c.root.toLowerCase() === root.toLowerCase() ? h('b', { class: 'ok' }, '✓ The snapshot rebuilds the root on chain.') : h('b', { class: 'bad' }, '✗ Mismatch.')))
  } catch (e) {
    step('bad', `Failed: ${e.message}`)
  } finally { btn.disabled = false }
}

function row(a) {
  const out = h('div', { class: 'verify-out' })
  const btn = h('button', { class: 'btn ghost', type: 'button', style: 'height:32px;padding:0 12px;font-size:13px' }, 'recompute')
  const detail = h('tr', { hidden: true }, h('td', { colspan: 6 }, out))
  btn.addEventListener('click', () => { detail.hidden = false; recompute(a, out, btn) })
  const tr = h('tr', { id: `e${a.epoch}` },
    h('td', { class: 'nw' }, h('b', null, nf(a.epoch))),
    h('td', { class: 'nw' }, fmtUtc(epochDate(a.epoch), { date: true })),
    h('td', { class: 'nw', title: a.root || '' }, short(a.root, 6), a.root ? copyButton(() => a.root, 'Copy root') : ''),
    h('td', { class: 'nw' }, nf(a.leafCount)),
    h('td', { class: 'nw' }, a.tx ? h('a', { href: a.explorer || txUrl(a.tx), target: '_blank', rel: 'noopener' }, short(a.tx, 5), arrow()) : h('span', { class: 'faint' }, a.status || 'not posted')),
    h('td', { class: 'nw' }, btn, ' ', h('a', { href: a.snapshotURI ? new URL(a.snapshotURI, location.href).pathname : `/snapshots/${a.epoch}.json`, class: 'faint' }, 'json')))
  return [tr, detail]
}

async function renderContract() {
  contract.textContent = ''
  const addr = anchorAddress(apiContract)
  const kv = h('dl', { class: 'kv' },
    h('dt', null, 'contract'), h('dd', null, addr ? [h('a', { href: addrUrl(addr), target: '_blank', rel: 'noopener' }, addr), ' ', copyButton(() => addr, 'Copy address')] : 'not configured'),
    h('dt', null, 'chain'), h('dd', null, 'Robinhood Chain (4663)'),
    h('dt', null, 'latest epoch on chain'), h('dd', { id: 'lat' }, addr ? 'reading…' : '—'),
    h('dt', null, 'read it yourself'), h('dd', null, addr ? h('a', { href: `${explorer()}/address/${addr}?tab=read_contract`, target: '_blank', rel: 'noopener' }, 'anchors(epoch) on Blockscout', arrow()) : '—'))
  contract.append(h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'ToolAnchor'), kv),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'What is in a leaf'),
      h('p', { class: 'muted' }, 'One leaf per server, skill and package: ', h('code', null, '[string key, string version, bytes32, bytes32, bytes32]'), ', hashed as ', h('code', null, 'keccak256(keccak256(abi.encode(values)))'), ' and sorted into an OpenZeppelin StandardMerkleTree. Full spec in ', h('a', { href: '/docs/#hashing' }, 'docs'), '.')))
  if (addr) chainLatestEpoch(addr).then((e) => { document.getElementById('lat').textContent = e ? `${nf(e)} · ${fmtUtc(epochDate(e), { date: true })}` : 'none posted yet' }).catch((e) => { document.getElementById('lat').textContent = `RPC error: ${e.message}` })
}

async function main() {
  try { const hl = await getHealth(); apiContract = hl?.contract?.address || hl?.contract || hl?.anchor?.address || null } catch {}
  onConfig(renderContract)
  try {
    const r = await getAnchors(500)
    apiContract = apiContract || r.contract
    renderContract()
    if (!r.anchors.length) { state.hidden = false; state.textContent = 'No hour has been anchored yet. The first root appears here after the hourly job posts it.'; return }
    for (const a of r.anchors) tbody.append(...row(a))
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' })
    const t = document.getElementById(location.hash.slice(1)); if (t) t.style.background = 'rgba(215,38,30,.08)'
  } catch {
    state.hidden = false; state.classList.add('err'); state.textContent = 'The anchors API is not reachable right now. The contract can still be read on Blockscout.'
  }
}
main()
void site
