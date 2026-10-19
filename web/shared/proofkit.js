// Prove that one item hash sat in one anchored hour, entirely in the browser:
// stored definition bytes → keccak256 = item hash → listed in the server leaf → list hash = leaf value → leaf hash →
// merkle path = root → anchors(epoch) on Robinhood Chain = root → verify(epoch, leaf, proof) = true.
import { h, nf, short, fmtUtc, epochDate, txUrl, arrow, explorer } from './site.js'
import { getProof, getObject } from './api.js'
import { keccakHex, leafHash, processProof, listHash, chainAnchor, chainVerify } from './chain.js'
import { anchorAddress } from './ui.js'

const LIST = { tool: ['tools', 2], prompt: ['prompts', 3], resource: ['resources', 4] }
export const itemName = (itemId, subject) => {
  const s = String(itemId || '')
  const rest = subject && s.startsWith(subject) ? s.slice(subject.length) : s.slice(s.indexOf('#'))
  return rest.replace(/^#/, '').replace(/^(tool|prompt|resource):/, '')
}

export async function proveSide({ subject, kind, name, hash, epoch, tx, contract }, onStep = () => {}) {
  const steps = []
  const step = (ok, ...kids) => { const s = { ok, kids }; steps.push(s); onStep(s); return ok }
  const out = { steps, ok: false, epoch, hash }
  // 1. the stored definition hashes to the item hash
  if (hash) {
    const obj = await getObject(hash)
    if (obj) { out.object = obj; step(keccakHex(obj.bytes) === hash.toLowerCase(), `stored definition (${nf(obj.bytes.length)} bytes) → keccak256 = ${short(keccakHex(obj.bytes), 6)}`, keccakHex(obj.bytes) === hash.toLowerCase() ? ' = item hash' : ` ≠ ${short(hash, 6)}`, ' · ', h('a', { href: obj.url, target: '_blank', rel: 'noopener' }, 'raw bytes', arrow())) }
    else step(null, 'stored definition bytes not available for this hash')
  }
  // 2. the leaf and its proof for that hour
  let p
  try { p = await getProof(epoch, subject) } catch (e) { step(false, `no proof for ${subject} in epoch ${nf(epoch)} (${e.message})`); return out }
  if (!p?.found && !p?.values) { step(false, `${subject} is not in epoch ${nf(epoch)}`); return out }
  out.values = p.values; out.proof = p.proof || []
  // 3. the item is listed in the leaf and the list hash matches the leaf value
  const L = LIST[kind]
  if (L && p.detail && Array.isArray(p.detail[L[0]])) {
    const list = p.detail[L[0]]
    const hit = list.find((x) => x[0] === name)
    if (hash) step(!!hit && hit[1].toLowerCase() === String(hash).toLowerCase(), `epoch ${nf(epoch)} lists ${L[0].slice(0, -1)} "${name}" with hash ${hit ? short(hit[1], 6) : '(missing)'}`)
    else step(!hit, `epoch ${nf(epoch)} lists ${nf(list.length)} ${L[0]}; "${name}" is ${hit ? 'already there' : 'not among them'}`)
    const lh = listHash(list.map((x) => x[1]))
    step(lh === String(p.values[L[1]]).toLowerCase(), `keccak256 of the ${nf(list.length)} sorted ${L[0]} hashes = ${short(lh, 6)} = leaf value #${L[1] + 1}`)
  } else if (kind === 'skill') {
    step(String(p.values[2]).toLowerCase() === String(hash).toLowerCase() ? true : null, `skill leaf file hash ${short(p.values[2], 6)}`)
  } else if (kind === 'package') {
    step(null, `package leaf: version ${p.values[1]}, integrity ${short(p.values[2], 6)}, maintainers ${short(p.values[3], 6)}`)
  }
  // 4. leaf hash + merkle path, computed here
  const leaf = leafHash(p.values.map(String))
  out.leaf = leaf
  const root = processProof(leaf, out.proof)
  out.root = root
  step(root === p.root, `leaf hash ${short(leaf, 6)} + ${out.proof.length}-step merkle path → root ${short(root, 6)}`, root === p.root ? '' : ` ≠ ${short(p.root, 6)}`)
  // 5. the chain
  const addr = anchorAddress(contract || p.contract)
  if (!addr) { step(null, 'ToolAnchor address not configured: chain step skipped'); return out }
  try {
    const a = await chainAnchor(addr, epoch)
    const okRoot = !!a && a.root.toLowerCase() === root.toLowerCase()
    step(okRoot, `anchors(${nf(epoch)}) on Robinhood Chain = ${a ? short(a.root, 6) : 'empty'}${a?.postedAt ? `, posted ${fmtUtc(new Date(a.postedAt * 1000))}` : ''}`, tx || p.tx ? [' · ', h('a', { href: txUrl(tx || p.tx), target: '_blank', rel: 'noopener' }, 'tx', arrow())] : '')
    const v = await chainVerify(addr, epoch, leaf, out.proof)
    step(v, h('span', null, 'verify(', nf(epoch), ', leaf, proof) eth_call on ', h('a', { href: `${explorer()}/address/${addr}?tab=read_contract`, target: '_blank', rel: 'noopener' }, short(addr)), ` → ${v}`))
    out.ok = okRoot && v && steps.every((s) => s.ok !== false)
  } catch (e) { step(false, `RPC call failed: ${e.message}`) }
  return out
}

export function stepList() { return h('ul', { class: 'steps-out' }) }
export function addStep(ul, s) { ul.append(h('li', { class: s.ok === true ? 'ok' : s.ok === false ? 'bad' : '' }, ...s.kids)) }
