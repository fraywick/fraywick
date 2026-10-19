// /proof: every anchored hour + "recompute this root" (snapshot → leaf hashes → StandardMerkleTree → compare with chain).
import { h, nf, short, fmtUtc, epochDate, txUrl, addrUrl, arrow, site, onConfig, copyButton, explorer } from '/shared/site.js'
import { getAnchors, getHealth, getFlags, absUrl, serverHref } from '/shared/api.js'
import { chainAnchor, chainLatestEpoch, chainVerify, selector, word32, RPC } from '/shared/chain.js'
import { chip } from '/shared/checkbox.js'
import { visible } from '/shared/ui.js'
import { anchorAddress } from '/shared/ui.js'

const tbody = document.querySelector('#tbl tbody'), state = document.getElementById('state'), contract = document.getElementById('contract')
let apiContract = null

// snapshot → every leaf hashed → StandardMerkleTree, in a worker so the page stays responsive
function runWorker(a, onMsg) {
  return new Promise((resolve) => {
    const w = new Worker('/shared/recompute-worker.js', { type: 'module' })
    w.onmessage = (e) => { onMsg?.(e.data); if (e.data.stage === 'done' || e.data.stage === 'error') { w.terminate(); resolve(e.data) } }
    w.onerror = (e) => { w.terminate(); resolve({ stage: 'error', text: e.message || 'worker failed' }) }
    w.postMessage({ url: new URL(absUrl(a.snapshotURI ? new URL(a.snapshotURI, location.href).pathname : `/snapshots/${a.epoch}.json`), location.href).href })
  })
}
const stageText = (m) => (m.stage === 'download' ? `downloading the snapshot… ${m.got ? (m.got / 1e6).toFixed(1) + ' MB' : ''}` : m.stage === 'hash' ? `hashing leaves… ${nf(m.done)} / ${nf(m.total)}` : m.text || m.stage)

async function recompute(a, out, btn) {
  btn.disabled = true
  out.textContent = ''
  const steps = h('ul', { class: 'steps-out' }), prog = h('p', { class: 'muted' })
  out.append(prog, steps)
  const step = (cls, ...k) => steps.append(h('li', { class: cls }, ...k))
  const r = await runWorker(a, (m) => { if (m.stage !== 'done') prog.textContent = stageText(m) })
  prog.textContent = ''
  if (r.stage === 'error') { step('bad', `Failed: ${r.text}`); btn.disabled = false; return }
  step('ok', `Snapshot: ${nf(r.leaves)} leaves, ${(r.bytes / 1e6).toFixed(1)} MB.`)
  if (r.mismatched != null) step(r.mismatched ? 'bad' : 'ok', r.mismatched ? `${nf(r.mismatched)} leaf hashes in the file do not match their values.` : 'Every leaf hash in the file matches its values.')
  step(r.root === a.root ? 'ok' : 'bad', `Root rebuilt in your browser in ${(r.msCompute / 1000).toFixed(1)} s: ${short(r.root, 8)} ${r.root === a.root ? '= API root' : '≠ API root ' + short(a.root, 8)}`)
  const addr = anchorAddress(apiContract)
  if (addr) {
    try {
      const c = await chainAnchor(addr, a.epoch)
      const same = c && c.root.toLowerCase() === r.root.toLowerCase()
      step(same ? 'ok' : 'bad', `anchors(${nf(a.epoch)}) on Robinhood Chain = ${c ? short(c.root, 8) : 'empty'}`)
      out.prepend(h('p', null, same ? h('b', { class: 'ok' }, '✓ The snapshot rebuilds the root on chain.') : h('b', { class: 'bad' }, '✗ Mismatch.')))
    } catch (e) { step('bad', `RPC failed: ${e.message}`) }
  }
  btn.disabled = false
}

// ── automatic proof of the latest anchored hour ──
const slowNet = () => { const c = navigator.connection; return !!(c && (c.saveData || /(^|-)2g|3g/.test(c.effectiveType || ''))) }
async function autoProof(a) {
  const box = document.getElementById('auto')
  box.textContent = ''
  const head = h('p', { class: 'headline' }, `Latest anchored hour: epoch ${nf(a.epoch)} · ${fmtUtc(epochDate(a.epoch), { date: true })} · ${nf(a.leafCount)} leaves`)
  const status = h('p', { class: 'muted' }), bar = h('div', { class: 'progress' }, h('i'))
  box.append(head, status)
  const go = async () => {
    status.textContent = 'Recomputing in your browser…'; box.append(bar)
    const t0 = performance.now()
    const [r, chain] = await Promise.all([
      runWorker(a, (m) => {
        status.textContent = stageText(m)
        const f = m.stage === 'download' ? 0.05 + 0.45 * Math.min(1, m.total ? m.got / (m.total * 2.6) : 0.5) : m.stage === 'parse' ? 0.55 : m.stage === 'hash' ? 0.6 + 0.3 * (m.done / m.total) : m.stage === 'tree' ? 0.93 : 1
        bar.firstChild.style.width = `${Math.round(f * 100)}%`
      }),
      anchorAddress(apiContract) ? chainAnchor(anchorAddress(apiContract), a.epoch).catch((e) => ({ error: e.message })) : Promise.resolve(null),
    ])
    bar.remove()
    if (r.stage === 'error') { status.textContent = `Could not recompute: ${r.text}`; return }
    const total = ((performance.now() - t0) / 1000).toFixed(1)
    const same = chain && !chain.error && chain.root.toLowerCase() === r.root.toLowerCase()
    head.textContent = ''
    head.append(same ? h('b', { class: 'ok' }, '✓ ') : h('b', { class: 'bad' }, '✗ '), 'Recomputed in your browser: root ', h('span', { class: 'mono-break' }, short(r.root, 10)), same ? ' = on-chain root ' : chain?.error ? ` (chain read failed: ${chain.error})` : ` ≠ on-chain root ${chain ? short(chain.root, 10) : '(empty)'}`, same ? h('b', { class: 'ok' }, '✓') : '')
    status.textContent = `${nf(r.leaves)} leaves of epoch ${nf(a.epoch)} hashed and rebuilt in ${(r.msCompute / 1000).toFixed(1)} s from the ${(r.bytes / 1e6).toFixed(1)} MB snapshot (${total} s total). `
    status.append(r.mismatched === 0 ? 'Every leaf hash listed in the file matches its values. ' : '', 'On-chain root read with ', h('code', null, `anchors(${a.epoch})`), ' via ', RPC.replace('https://', ''), h('span', null, a.tx ? [' · ', h('a', { href: txUrl(a.tx), target: '_blank', rel: 'noopener' }, 'anchor tx', arrow())] : ''), '.')
    if (r.sample) sampleLeaf(a, r.sample)
    renderCommands(a, r.root, r.sample)
  }
  renderCommands(a, a.root, null)
  if (innerWidth < 760 || slowNet()) {
    status.textContent = `Your browser can download this hour's snapshot (about ${Math.max(1, Math.round(a.leafCount / 1600))} MB), hash all ${nf(a.leafCount)} leaves and compare the root with the chain.`
    const btn = h('button', { class: 'btn', type: 'button' }, 'Recompute in my browser')
    btn.addEventListener('click', () => { btn.remove(); go() })
    box.append(btn)
  } else go()
}

async function sampleLeaf(a, s) {
  const box = document.getElementById('sample')
  box.hidden = false; box.textContent = ''
  const res = h('p', { class: 'headline' }, 'Checking one sample leaf with verify() on chain…')
  box.append(h('h3', { style: 'margin-top:0' }, 'One sample leaf, proven on chain'), res,
    h('dl', { class: 'kvs' },
      h('dt', null, 'leaf key'), h('dd', null, h('a', { href: serverHref(s.key) }, visible(s.key))),
      h('dt', null, 'values'), h('dd', { class: 'mono-break' }, JSON.stringify(s.values)),
      h('dt', null, 'leaf hash'), h('dd', { class: 'mono-break' }, s.leaf),
      h('dt', null, 'proof'), h('dd', null, `${s.proof.length} sibling hashes, computed in your browser from the rebuilt tree (not fetched from us)`)))
  const addr = anchorAddress(apiContract)
  if (!addr) { res.textContent = 'ToolAnchor address not configured.'; return }
  try {
    const ok = await chainVerify(addr, a.epoch, s.leaf, s.proof)
    res.textContent = ''
    res.append(ok ? h('b', { class: 'ok' }, '✓ ') : h('b', { class: 'bad' }, '✗ '), `verify(${a.epoch}, leaf, proof) eth_call → ${ok}`)
  } catch (e) { res.textContent = `RPC failed: ${e.message}` }
}

function cmd(titleText, text, expect) {
  return h('div', { class: 'cmd' }, h('h3', null, titleText), h('pre', null, text), copyButton(() => text, 'Copy command'), expect ? h('p', { class: 'expect' }, expect) : '')
}
function renderCommands(a, root, sample) {
  const box = document.getElementById('cmds')
  box.textContent = ''
  const addr = anchorAddress(apiContract)
  if (!addr) { box.append(h('p', { class: 'muted' }, 'ToolAnchor address not configured.')); return }
  const data = selector('anchors(uint64)') + word32(a.epoch)
  const base = location.origin.startsWith('http://127.') || location.origin.startsWith('http://localhost') ? 'https://fraywick.xyz' : location.origin
  box.append(
    cmd(`1 · Read anchors(${a.epoch}) from the chain with curl`, `curl -s ${RPC} -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"${addr}","data":"${data}"},"latest"]}'`,
      `Expected "result": 0x + root + leafCount + postedAt. The first 32 bytes must be ${root}`),
    cmd('2 · Rebuild the root from the snapshot with the OpenZeppelin library', `mkdir fw-check && cd fw-check && npm i @openzeppelin/merkle-tree@1.0.8
curl -s --compressed ${base}/snapshots/${a.epoch}.json -o s.json
node -e 'const {StandardMerkleTree}=require("@openzeppelin/merkle-tree");const s=require("./s.json");console.log(StandardMerkleTree.of(s.leaves.map(l=>l.v),s.encoding).root, s.leaves.length)'`,
      `Expected: ${root} ${nf(a.leafCount).replace(/,/g, '')}`),
    cmd('3 · Same with Foundry cast', `cast call ${addr} "anchors(uint64)(bytes32,uint32,uint64)" ${a.epoch} --rpc-url ${RPC}` + (sample ? `
cast call ${addr} "verify(uint64,bytes32,bytes32[])(bool)" ${a.epoch} ${sample.leaf} "[${sample.proof.join(',')}]" --rpc-url ${RPC}` : ''),
      sample ? `Expected: ${root}, ${a.leafCount}, <postedAt> and then true` : `Expected first value: ${root}`),
  )
}

async function renderFlags() {
  const box = document.getElementById('flags')
  try {
    const r = await getFlags()
    const list = r?.flags || []
    if (!list.length) { box.append(h('p', { class: 'muted' }, 'No change has been flagged on chain.')); return }
    const tb = h('tbody')
    for (const f of list) {
      const cur = f.revisedLabel || f.label, orig = f.originalLabel || f.label
      tb.append(h('tr', null,
        h('td', { class: 'nw' }, h('a', { href: `/proof/#e${f.anchorEpoch ?? f.epoch}` }, nf(f.anchorEpoch ?? f.epoch))),
        h('td', { class: 'name' }, h('a', { href: `/change/?id=${f.id}` }, visible(f.subject))),
        h('td', { class: 'nw' }, chip(orig), f.originalScore ?? f.score != null ? ` ${f.originalScore ?? f.score}` : ''),
        h('td', { class: 'nw' }, f.revisedLabel ? [chip(cur), f.revisedScore != null ? ` ${f.revisedScore}` : ''] : h('span', { class: 'muted' }, 'unchanged')),
        h('td', null, f.revisedNote ? visible(f.revisedNote) : ''),
        h('td', { class: 'nw' }, f.flag?.tx ? h('a', { href: txUrl(f.flag.tx), target: '_blank', rel: 'noopener' }, short(f.flag.tx, 4), arrow()) : h('span', { class: 'muted' }, f.flag?.status || '—'))))
    }
    box.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, 'Epoch'), h('th', null, 'Item'), h('th', null, 'Flagged as'), h('th', null, 'Current label'), h('th', null, 'Note'), h('th', null, 'Flag tx'))), tb)))
  } catch { box.append(h('p', { class: 'muted' }, 'The flags API is not reachable right now.')) }
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
    const latest = r.anchors.find((a) => a.onChain !== false && a.tx) || r.anchors[0]
    if (latest) autoProof(latest)
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' })
    const t = document.getElementById(location.hash.slice(1)); if (t) t.style.background = 'rgba(215,38,30,.08)'
  } catch {
    state.hidden = false; state.classList.add('err'); state.textContent = 'The anchors API is not reachable right now. The contract can still be read on Blockscout.'
  }
}
main()
renderFlags()
void site
