// Inner-page building blocks: hidden-unicode-visible text, side-by-side diff, change timeline, in-browser proof check.
// Third-party text only ever goes through text nodes.
import { h, nf, short, fmtUtc, epochDate, txUrl, site, isAddr, arrow, explorer } from './site.js'
import { getProof, serverHref } from './api.js'
import { leafHash, processProof, chainVerify, chainAnchor, RPC } from './chain.js'
import { chip } from './checkbox.js'

// zero-width, bidi controls, BOM, soft hyphen, invisible operators, tag characters, other C0/C1 controls (not \n \t)
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ￹-￻]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]|\uDB40[\uDC00-\uDC7F]/g
export const hasInvisible = (s) => { INVISIBLE.lastIndex = 0; return INVISIBLE.test(String(s ?? '')) }
export function countInvisible(s) { return (String(s ?? '').match(INVISIBLE) || []).length }

// text with every invisible character shown as a red U+XXXX badge
export function visible(s, cls) {
  const frag = document.createDocumentFragment()
  const str = String(s ?? '')
  let last = 0
  INVISIBLE.lastIndex = 0
  for (const m of str.matchAll(INVISIBLE)) {
    if (m.index > last) frag.append(str.slice(last, m.index))
    const cp = m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
    frag.append(h('span', { class: 'inv', title: 'hidden character' }, `U+${cp}`))
    last = m.index + m[0].length
  }
  if (last < str.length) frag.append(str.slice(last))
  if (cls) { const sp = h('span', { class: cls }); sp.append(frag); return sp }
  return frag
}

const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2))
const tok = (s) => s.match(/\s+|[^\s]+/g) || []

// word-level LCS diff → [{t:'eq'|'del'|'ins', s}]
export function wordDiff(a, b) {
  const A = tok(a), B = tok(b)
  if (A.length * B.length > 4e6) return null
  const n = A.length, m = B.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out = []
  let i = 0, j = 0
  const push = (t, s) => { const l = out[out.length - 1]; if (l && l.t === t) l.s += s; else out.push({ t, s }) }
  while (i < n && j < m) {
    if (A[i] === B[j]) { push('eq', A[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', A[i++])
    else push('ins', B[j++])
  }
  while (i < n) push('del', A[i++])
  while (j < m) push('ins', B[j++])
  return out
}

export function diffView(before, after, { title, beforeLabel = 'before', afterLabel = 'after' } = {}) {
  const a = asText(before), b = asText(after)
  const ops = wordDiff(a, b)
  const left = h('pre'), right = h('pre')
  if (ops) {
    for (const o of ops) {
      if (o.t !== 'ins') left.append(o.t === 'del' ? visible(o.s, 'del') : visible(o.s))
      if (o.t !== 'del') right.append(o.t === 'ins' ? visible(o.s, 'ins') : visible(o.s))
    }
  } else { left.append(visible(a)); right.append(visible(b)) }
  if (!a) left.append(h('span', { class: 'faint' }, '(none)'))
  if (!b) right.append(h('span', { class: 'faint' }, '(none)'))
  const ia = countInvisible(a), ib = countInvisible(b)
  const box = h('div', { class: 'diff' },
    h('div', { class: 'col' }, h('div', { class: 'hd' }, h('span', null, beforeLabel), ia ? h('span', { class: 'err' }, `${ia} hidden char${ia > 1 ? 's' : ''}`) : ''), left),
    h('div', { class: 'col' }, h('div', { class: 'hd' }, h('span', null, afterLabel), ib ? h('span', { class: 'err' }, `${ib} hidden char${ib > 1 ? 's' : ''}`) : ''), right))
  return title ? [h('p', { class: 'diff-field' }, title), box] : box
}

// server diff ops [[op, text], …] (op '=' | '+' | '-') → side by side
export function opsView(ops, { title, beforeLabel = 'before', afterLabel = 'after' } = {}) {
  const left = h('pre'), right = h('pre')
  let ia = 0, ib = 0
  for (const [op, t] of ops) {
    if (op !== '+') { left.append(op === '-' ? visible(t, 'del') : visible(t)); if (op === '-') ia += countInvisible(t) }
    if (op !== '-') { right.append(op === '+' ? visible(t, 'ins') : visible(t)); if (op === '+') ib += countInvisible(t) }
  }
  const box = h('div', { class: 'diff' },
    h('div', { class: 'col' }, h('div', { class: 'hd' }, h('span', null, beforeLabel), ia ? h('span', { class: 'err' }, `${ia} hidden removed`) : ''), left),
    h('div', { class: 'col' }, h('div', { class: 'hd' }, h('span', null, afterLabel), ib ? h('span', { class: 'err' }, `${ib} hidden char${ib > 1 ? 's' : ''} added`) : ''), right))
  return title ? [h('p', { class: 'diff-field' }, title), box] : box
}
const isOps = (x) => Array.isArray(x) && x.every((o) => Array.isArray(o) && typeof o[0] === 'string')

// a change's before/after → one or more diff views (description, schema, whole body)
export function changeDiffs(c, labels = {}) {
  const out = []
  if (c.diff && !Array.isArray(c.diff) && typeof c.diff === 'object') {
    for (const [k, v] of Object.entries(c.diff)) if (isOps(v)) out.push(opsView(v, { title: k, ...labels }))
    if (out.length) return out
  }
  if (Array.isArray(c.diff) && c.diff.some((d) => d && d.ops)) {
    for (const d of c.diff) {
      if (d.ops && typeof d.ops === 'object' && !Array.isArray(d.ops)) for (const [k, v] of Object.entries(d.ops)) { if (isOps(v)) out.push(opsView(v, { title: `${d.title} · ${k}`, ...labels })) }
      else if (isOps(d.ops)) out.push(opsView(d.ops, { title: d.title, ...labels }))
      else out.push(h('p', { class: 'diff-field' }, d.title, ' ', h('span', { class: 'faint' }, d.status === 'new' ? '(new, not in the anchor)' : d.status === 'missing' ? '(in the anchor, gone now)' : d.status === 'not_anchored' ? '(not anchored)' : '(changed, previous text not held)')))
    }
    return out
  }
  if (Array.isArray(c.diff) && c.diff.length && c.diff.every((d) => d && ('before' in d || 'after' in d))) {
    for (const d of c.diff) out.push(diffView(d.before, d.after, { title: [d.tool, d.field].filter(Boolean).join(' · ') || null }))
    return out
  }
  const b = c.before, a = c.after
  if (b && a && typeof b === 'object' && typeof a === 'object') {
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => asText(b[k]) !== asText(a[k]))
    for (const k of keys) out.push(diffView(b[k], a[k], { title: k }))
    if (out.length) return out
  }
  if (b != null || a != null) out.push(diffView(b, a))
  else if (typeof c.diff === 'string') out.push(h('pre', { class: 'diff-raw' }, visible(c.diff)))
  return out
}

export function reasonsList(reasons) {
  if (!reasons?.length) return h('p', { class: 'muted' }, 'No scoring rule fired.')
  return h('ul', { class: 'reasons' }, reasons.map((r) => h('li', null, h('span', { class: 'w' }, r.weight != null ? `+${r.weight}` : '·'), h('span', null, visible(r.text || r.code || '')))))
}

export function changeLine(c, { link = true } = {}) {
  return h('li', { class: c.label || '' },
    h('div', { class: 'when' }, `epoch ${nf(c.epoch)} · ${fmtUtc(c.at || epochDate(c.epoch), { date: true })}`),
    h('div', null, c.change === 'added' ? h('span', { class: 'chip added' }, 'first seen') : c.change === 'removed' ? h('span', { class: 'chip removed' }, 'removed') : chip(c.label), ' ',
      c.tool ? h('b', null, visible(c.tool)) : '', c.tool ? ' · ' : '', c.change && !['added', 'removed', 'changed'].includes(c.change) ? `${c.change} changed · ` : '',
      c.score != null && c.change !== 'added' ? `score ${c.score}/100` : '',
      link && c.itemId ? [' · ', h('a', { href: serverHref(c.itemId) }, 'server')] : '',
      c.tx ? [' · ', h('a', { href: txUrl(c.tx), target: '_blank', rel: 'noopener' }, 'anchor tx', arrow())] : '',
      c.flagTx ? [' · ', h('a', { href: txUrl(c.flagTx), target: '_blank', rel: 'noopener' }, 'flag tx', arrow())] : ''),
    c.newHash ? h('div', { class: 'faint' }, c.oldHash ? `${short(c.oldHash, 6)} → ${short(c.newHash, 6)}` : short(c.newHash, 6)) : '')
}

export function anchorAddress(fallback) {
  if (isAddr(site.anchor_address)) return site.anchor_address
  if (isAddr(fallback)) return fallback
  return null
}

// fetch /api/proof → recompute leaf + root locally → read anchors(epoch) and verify() on Robinhood Chain
export async function verifyInBrowser(leafKey, epoch, out, { contract } = {}) {
  out.textContent = ''
  const steps = h('ul', { class: 'steps-out' })
  out.append(steps)
  const step = (cls, ...kids) => { const li = h('li', { class: cls }, ...kids); steps.append(li); return li }
  let p
  try { p = await getProof(epoch, leafKey) } catch (e) { step('bad', `No proof from the API (${e.message}).`); return false }
  const values = p.values || p.leaf?.values || p.v
  const proof = p.proof || []
  const ep = Number(p.epoch ?? epoch)
  let leaf = p.leaf?.hash || p.leafHash || (typeof p.leaf === 'string' ? p.leaf : null)
  if (Array.isArray(values) && values.length === 5) {
    const mine = leafHash(values.map(String))
    step(leaf && mine !== leaf ? 'bad' : 'ok', `Leaf recomputed in your browser from [${values.map((v) => (String(v).length > 22 ? short(String(v), 6) : v)).join(', ')}] → ${short(mine, 6)}`)
    leaf = mine
  } else if (!leaf) { step('bad', 'The proof has no leaf values.'); return false }
  const root = processProof(leaf, proof)
  step(p.root && root !== p.root ? 'bad' : 'ok', `Merkle path (${proof.length} step${proof.length === 1 ? '' : 's'}) gives root ${short(root, 6)}${p.root ? (root === p.root ? ', same as the API' : ', API says ' + short(p.root, 6)) : ''}`)
  const addr = anchorAddress(contract || p.contract || p.address)
  if (!addr) { step('', 'The ToolAnchor address is not configured on this site, so the on-chain step is skipped.'); return null }
  try {
    const a = await chainAnchor(addr, ep)
    if (!a || /^0x0+$/.test(a.root)) { step('bad', `anchors(${nf(ep)}) on chain is empty: this hour is not posted (yet or ever).`); return false }
    step(a.root.toLowerCase() === root.toLowerCase() ? 'ok' : 'bad', `anchors(${nf(ep)}) on Robinhood Chain = ${short(a.root, 6)}, ${nf(a.leafCount)} leaves, posted ${fmtUtc(new Date(a.postedAt * 1000), { date: true })}`)
    const ok = await chainVerify(addr, ep, leaf, proof)
    step(ok ? 'ok' : 'bad', h('span', null, `verify(${nf(ep)}, leaf, proof) on `, h('a', { href: `${explorer()}/address/${addr}?tab=read_contract`, target: '_blank', rel: 'noopener' }, `ToolAnchor ${short(addr)}`), ` → ${ok}`))
    out.prepend(h('p', null, h('b', { class: ok ? 'ok' : 'bad' }, ok ? '✓ Verified on chain.' : '✗ Not verified.'), ok ? ' The definition we hold for this hour is in the anchored root.' : ''))
    return ok
  } catch (e) {
    step('bad', `RPC call failed (${RPC.replace('https://', '')}): ${e.message}`)
    return false
  }
}
