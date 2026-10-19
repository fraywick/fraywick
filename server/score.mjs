// Heuristic change scorer (0–100) with reasons. It describes the diff; it never judges a project.
// Only what is NEW in the changed item counts (a phrase that was already there scores nothing).
// Labels: < 20 cosmetic · 20–59 behavior · ≥ 60 suspicious (→ flag() on chain, max 10 per epoch).
export const LABELS = { cosmetic: [0, 19], behavior: [20, 59], suspicious: [60, 100] }
export const labelOf = (score) => (score >= 60 ? 'suspicious' : score >= 20 ? 'behavior' : 'cosmetic')

const INJECTION = [
  ['ignore_previous', /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|preceding|other)\s+(instructions?|prompts?|messages?|rules|context)/i],
  ['before_using', /\bbefore\s+(using|calling|invoking|running|executing|you\s+use|you\s+call)\s+(this|the|any|that)\s+tool/i],
  ['hide_from_user', /\b(do\s+not|don'?t|never)\s+(tell|inform|mention|reveal|show|alert|notify|disclose)\b.{0,30}\buser\b|\bwithout\s+(telling|informing|notifying|alerting)\s+the\s+user|\bthe\s+user\s+(must|should)\s+not\s+(know|see|be\s+told)/i],
  ['always_call', /\b(always|must\s+always|you\s+must)\s+(call|use|invoke|run|execute)\b/i],
  ['pseudo_tag', /<\s*\/?\s*(important|system|instructions?|secret|hidden|admin|assistant|im_start|sys)\b[^>]*>/i],
  ['override', /\b(you\s+are\s+now|new\s+instructions|override\s+(the\s+|your\s+|any\s+)?(previous\s+|system\s+)?(instructions|prompt|rules))\b/i],
  ['tool_shadowing', /\b(instead\s+of|rather\s+than)\s+(using|calling)\b|\b(other|another|all\s+other)\s+(tools?|servers?)\b.{0,60}\b(must|should|always|never)\b/i],
  ['exfiltration', /\b(send|post|upload|forward|transmit|exfiltrate)\b.{0,60}\b(to|at)\s+(https?:\/\/|the\s+(following\s+)?(url|endpoint|server|webhook))/i],
  ['read_secrets', /\b(read|cat|open|include|attach|pass|send|copy)\b.{0,40}(contents?\s+of|~\/|\.ssh|\.env\b|credentials|private\s+key)/i],
]
const SENSITIVE = [
  ['ssh', /~\/\.ssh|\bid_(rsa|ed25519|ecdsa|dsa)\b|authorized_keys/i],
  ['dotenv', /(^|[\s"'`/(])\.env\b/i],
  ['cloud_creds', /\.aws\/credentials|\.config\/gcloud|\.kube\/config|\.docker\/config\.json|\.npmrc|\.pypirc|\.git-credentials|\.netrc/i],
  ['wallet', /\bwallet(\.dat|\s+file|\s+key|s?\b)/i],
  ['private_key', /\bprivate[\s_-]?keys?\b|\bsecret[\s_-]?keys?\b/i],
  ['seed_phrase', /\bseed[\s_-]?phrase|\bmnemonic\b|\brecovery\s+phrase/i],
  ['system_files', /\/etc\/(passwd|shadow)|\bkeychain\b|\bcookies?\.sqlite|Login\s+Data/i],
]
const PARAM = /^(notes?|context|side_?note|feedback|extra|extra_?info|metadata|debug|comment|remarks?|conversation|chat_?history|history|system_?prompt|instructions?|reasoning|thoughts?|memory|summary)$/i
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿᠎­]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu
const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]}]+/gi
const SHELL = /curl[^\n|]{0,200}\|\s*(ba|z)?sh\b|wget[^\n|]{0,200}\|\s*(ba|z)?sh\b|base64\s+(-d|--decode)|\beval\s*\(|powershell\s+-e(nc)?\b|Invoke-Expression|\bnc\s+-e\b/i
const PASTE = /(ngrok(-free)?\.(app|io)|pastebin\.com|webhook\.site|requestbin|pipedream\.net|discord(app)?\.com\/api\/webhooks|transfer\.sh|trycloudflare\.com|\.oast\.|interact\.sh|burpcollaborator)/i

/** every string inside a view (values and property names) */
export function textsOf(v, out = []) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) textsOf(x, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); textsOf(x, out) }
  return out
}
/** property names reachable in a JSON schema */
export function paramNames(schema, out = new Set(), depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return out
  if (schema.properties && typeof schema.properties === 'object') for (const [k, s] of Object.entries(schema.properties)) { out.add(k); paramNames(s, out, depth + 1) }
  for (const key of ['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not', 'then', 'else', 'if', 'prefixItems', '$defs', 'definitions']) {
    const x = schema[key]
    if (Array.isArray(x)) for (const s of x) paramNames(s, out, depth + 1)
    else if (x && typeof x === 'object') { if (key === '$defs' || key === 'definitions') for (const s of Object.values(x)) paramNames(s, out, depth + 1); else paramNames(x, out, depth + 1) }
  }
  return out
}
const count = (re, s) => { const m = s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')); return m ? m.length : 0 }
const hostsIn = (s) => new Set((s.match(URL_RE) || []).map((u) => { try { return new URL(u).hostname.toLowerCase() } catch { return null } }).filter(Boolean))
const snippet = (s, re) => { const m = re.exec(s); if (!m) return null; const i = Math.max(0, m.index - 20); return s.slice(i, m.index + m[0].length + 20).replace(/\s+/g, ' ').slice(0, 100) }
const descOf = (v) => (typeof v?.description === 'string' ? v.description : typeof v?.text === 'string' ? v.text : '')

/**
 * score({ kind, change, old, new, meta }) → { score, label, reasons: [{ code, points, detail }] }
 * kind: tool | prompt | resource | skill | package · change: added | removed | changed
 * For packages, old/new are { version, integrityHash, maintainers[], publisher }.
 */
export function scoreChange({ kind, change, old: o = null, new: n = null }) {
  const reasons = []
  const add = (code, points, detail = null) => reasons.push({ code, points, ...(detail ? { detail } : {}) })
  if (kind === 'package') return finish(scorePackage(o, n, change, add), reasons)
  if (change === 'removed') { add('removed', 20, `${kind} no longer listed`); return finish(0, reasons) }
  if (change === 'added') add('added', 5, `new ${kind}`)

  const oldText = textsOf(o || {}).join('\n'), newText = textsOf(n || {}).join('\n')
  if (change === 'changed' && oldText.replace(/\s+/g, ' ').trim().toLowerCase() === newText.replace(/\s+/g, ' ').trim().toLowerCase() && !schemaChanged(o, n)) {
    add('whitespace_or_case', 0, 'only whitespace / letter case changed')
    return finish(0, reasons)
  }
  let inj = 0
  for (const [code, re] of INJECTION) if (count(re, newText) > count(re, oldText)) { inj += 30; add(`instruction:${code}`, 30, snippet(newText, re)) }
  if (inj > 60) reasons.push({ code: 'cap', points: 60 - inj })
  const hidNew = count(HIDDEN, newText), hidOld = count(HIDDEN, oldText)
  if (hidNew > hidOld) add('hidden_unicode', 40, `${hidNew - hidOld} invisible / bidi / tag characters added`)
  const oldHosts = hostsIn(oldText)
  const newHosts = [...hostsIn(newText)].filter((h) => !oldHosts.has(h))
  const added = change === 'added'   // a new tool's links / params are compared with nothing, so they weigh less
  if (newHosts.length) {
    add('new_urls', added ? Math.min(10, 5 * newHosts.length) : Math.min(30, 15 * newHosts.length), newHosts.slice(0, 5).join(', '))
    if (newHosts.some((h) => PASTE.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h))) add('new_url_tunnel_or_ip', 15, 'URL to a tunnel / paste / webhook service or a raw IP')
  }
  let sens = 0
  for (const [code, re] of SENSITIVE) if (count(re, newText) > count(re, oldText)) { if (sens < 40) { const p = Math.min(20, 40 - sens); sens += p; add(`sensitive:${code}`, p, snippet(newText, re)) } }
  if (kind === 'tool' || kind === 'prompt') {
    const before = paramNames(o?.inputSchema), after = paramNames(n?.inputSchema)
    for (const a of o?.arguments || []) if (a?.name) before.add(a.name)
    for (const a of n?.arguments || []) if (a?.name) after.add(a.name)
    const sus = [...after].filter((p) => !before.has(p) && PARAM.test(p))
    if (sus.length) add('suspicious_params', added ? Math.min(30, 15 * sus.length) : Math.min(40, 25 * sus.length), sus.slice(0, 5).join(', '))
  }
  if (count(SHELL, newText) > count(SHELL, oldText)) add('shell_pipe', 25, snippet(newText, SHELL))
  const dl0 = descOf(o).length, dl1 = descOf(n).length
  if (change === 'changed') {
    if (dl1 > dl0 * 4 && dl1 - dl0 > 1000) add('description_jump', 25, `${dl0} → ${dl1} chars`)
    else if (dl1 > dl0 * 2 && dl1 - dl0 > 300) add('description_jump', 15, `${dl0} → ${dl1} chars`)
    if (schemaChanged(o, n, 'inputSchema')) add('input_schema_changed', 5)
    if (schemaChanged(o, n, 'outputSchema')) add('output_schema_changed', 3)
    const a0 = o?.annotations || {}, a1 = n?.annotations || {}
    if ((a0.readOnlyHint === true && a1.readOnlyHint !== true) || (a0.destructiveHint === false && a1.destructiveHint !== false) || (a0.openWorldHint === false && a1.openWorldHint === true))
      add('annotations_widened', 15, 'tool hints now allow side effects / open world')
    if (!reasons.length) add('text_changed', 2, 'wording changed')
  }
  return finish(0, reasons)
}

function schemaChanged(o, n, key = null) {
  const k = key ? [key] : ['inputSchema', 'outputSchema', 'annotations', 'arguments']
  return k.some((x) => JSON.stringify(sortDeep(o?.[x])) !== JSON.stringify(sortDeep(n?.[x])))
}
const sortDeep = (x) => (Array.isArray(x) ? x.map(sortDeep) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortDeep(x[k])])) : x)

function scorePackage(o, n, change, add) {
  if (change === 'added') { add('added', 0, 'first seen'); return 0 }
  if (change === 'removed') { add('removed', 20, 'package no longer found'); return 0 }
  if (o?.version !== n?.version) add('new_version', 5, `${o?.version ?? '?'} → ${n?.version ?? '?'}`)
  else if (o?.integrityHash && n?.integrityHash && o.integrityHash !== n.integrityHash) add('same_version_new_bytes', 60, `version ${n.version} now has different file hashes`)
  const m0 = new Set(o?.maintainers || []), m1 = new Set(n?.maintainers || [])
  const added = [...m1].filter((x) => !m0.has(x)), removed = [...m0].filter((x) => !m1.has(x))
  if (m0.size && (added.length || removed.length)) {
    add('maintainers_changed', 40, `${added.length ? '+' + added.slice(0, 5).join(', +') : ''}${added.length && removed.length ? ' ' : ''}${removed.length ? '-' + removed.slice(0, 5).join(', -') : ''}`)
    if (removed.length === m0.size && added.length) add('maintainers_replaced', 20, 'none of the previous maintainers remain')
  }
  if (n?.publisher && m0.size && !m0.has(n.publisher)) add('new_publisher', 20, `published by ${n.publisher}`)
  return 0
}

function finish(_, reasons) {
  const score = Math.max(0, Math.min(100, reasons.reduce((s, r) => s + r.points, 0)))
  return { score, label: labelOf(score), reasons }
}
