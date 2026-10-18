// RFC 8785 JSON Canonicalization Scheme. Shared verbatim with cli/lib/jcs.mjs (deploy.sh --check compares them).
// Keys sorted by UTF-16 code units (JS default sort), numbers in ECMAScript shortest form (JSON.stringify), strings escaped as
// JSON.stringify does (the JCS escaping rules). Non-finite numbers and lone surrogates are rejected; undefined members are omitted.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export function canonicalize(v) {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v)
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('jcs: non-finite number')
    return JSON.stringify(v)
  }
  if (typeof v === 'string') {
    if (LONE.test(v)) throw new Error('jcs: lone surrogate')
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonicalize(x))).join(',') + ']'
  if (typeof v === 'object') {
    if (typeof v.toJSON === 'function') return canonicalize(v.toJSON())
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return '{' + keys.map((k) => canonicalize(k) + ':' + canonicalize(v[k])).join(',') + '}'
  }
  throw new Error(`jcs: unsupported type ${typeof v}`)
}
