// Shared configuration. Nothing here holds a key (the poster key is read in chain.mjs and never logged).
//
// Env (all optional):
//   PORT (4891) · BIND · ROLE=api|crawler|all · DATA_DIR (server/data) · DB=memory · TRUST_PROXY=1 · SERVE_WEB=1
//   PUBLIC_URL=https://fraywick.dev (else https://<.deploy-domain>; used for snapshot URIs, the bot UA and links)
//   TOKEN_JSON (../web/token.json) · DEPLOYMENT_JSON (../contracts/deployments/robinhood.json) · ANCHOR_ABI_JSON · ANCHOR_ADDRESS
//   RPC_URL (https://robinhood-rpc.publicnode.com) · DRY_POST=1 (default) / DRY_POST=0 (send) · POSTER_PRIVATE_KEY (chain.mjs)
//   GITHUB_TOKEN (skills) · CONCURRENCY (16) · HOST_SPACING_MS (1000) · NO_NETWORK=1 (tests)
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const SERVER_DIR = fileURLToPath(new URL('./', import.meta.url))
export const DATA_DIR = () => process.env.DATA_DIR || SERVER_DIR + 'data'
export const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
export const CHAIN_ID = 4663
export const EXPLORER = 'https://robinhoodchain.blockscout.com'
export const DEFAULT_RPC = 'https://robinhood-rpc.publicnode.com'
export const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''))
export const isZeroAddr = (a) => !isAddr(a) || String(a).toLowerCase() === ZERO_ADDR
export const VERSION = '1.0.0'

const files = new Map()
/** JSON file cached by mtime, re-checked at most every maxAgeMs */
export function readJson(path, { maxAgeMs = 30_000 } = {}) {
  const hit = files.get(path)
  if (hit && Date.now() - hit.checked < maxAgeMs) return hit.value
  let value = hit ? hit.value : null, mtime = 0
  try {
    mtime = statSync(path).mtimeMs
    if (!hit || hit.mtime !== mtime) value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) { if (e.code === 'ENOENT') value = null; else if (!hit) console.error(`config: ${path}: ${e.message}`) }
  files.set(path, { checked: Date.now(), mtime, value })
  return value
}

export const paths = {
  token: () => process.env.TOKEN_JSON || ROOT + 'web/token.json',
  deployment: () => process.env.DEPLOYMENT_JSON || ROOT + 'contracts/deployments/robinhood.json',
  abi: () => process.env.ANCHOR_ABI_JSON || ROOT + 'contracts/abi/ToolAnchor.json',
  skills: () => process.env.SKILLS_JSON || SERVER_DIR + 'sources/skills.json',
  optout: () => process.env.OPTOUT_JSON || SERVER_DIR + 'sources/optout.json',
  snapshots: () => DATA_DIR() + '/snapshots',
}

export function token() {
  return readJson(paths.token()) || { ca: ZERO_ADDR, symbol: null, decimals: 18, launch_at: null, pons_token_url: null }
}
/** preview until token.json carries a real contract address */
export const mode = () => (isZeroAddr(token().ca) ? 'preview' : 'live')

function domainFile() {
  try { return readFileSync(ROOT + '.deploy-domain', 'utf8').trim() || null } catch { return null }
}
/** https://<domain> without trailing slash, or null while no domain is configured */
export function publicUrl() {
  const u = process.env.PUBLIC_URL || (domainFile() ? `https://${domainFile()}` : '')
  return u ? u.replace(/\/+$/, '') : null
}
export function userAgent() {
  const p = publicUrl()
  return p ? `FraywickBot/1.0 (+${p}/docs#bot)` : 'FraywickBot/1.0 (+read-only MCP tools/list crawler; docs#bot)'
}

/** ToolAnchor address: env ANCHOR_ADDRESS, else contracts/deployments/robinhood.json (several shapes), else null */
export function anchorConfig() {
  if (isAddr(process.env.ANCHOR_ADDRESS) && !isZeroAddr(process.env.ANCHOR_ADDRESS)) return { address: process.env.ANCHOR_ADDRESS, source: 'env ANCHOR_ADDRESS', chainId: CHAIN_ID }
  const d = readJson(paths.deployment())
  if (!d) return { address: null, source: null, chainId: CHAIN_ID }
  for (const c of [d.ToolAnchor, d.toolAnchor, d.anchor, d.contracts?.ToolAnchor, d]) {
    if (!c) continue
    const a = typeof c === 'string' ? c : c.address
    if (isAddr(a) && !isZeroAddr(a)) return { address: a, source: 'contracts/deployments/robinhood.json', chainId: Number(d.chainId || CHAIN_ID), block: d.blockNumber ?? c.blockNumber ?? null }
  }
  return { address: null, source: null, chainId: CHAIN_ID }
}

export const ANCHOR_ABI_DEFAULT = [
  { type: 'function', name: 'post', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'epoch', type: 'uint64' }, { name: 'root', type: 'bytes32' }, { name: 'leafCount', type: 'uint32' }, { name: 'snapshotURI', type: 'string' }] },
  { type: 'function', name: 'flag', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'epoch', type: 'uint64' }, { name: 'subject', type: 'bytes32' }, { name: 'oldHash', type: 'bytes32' }, { name: 'newHash', type: 'bytes32' },
    { name: 'severity', type: 'uint8' }, { name: 'note', type: 'string' }] },
  { type: 'function', name: 'anchors', stateMutability: 'view', inputs: [{ name: 'epoch', type: 'uint64' }], outputs: [
    { name: 'root', type: 'bytes32' }, { name: 'leafCount', type: 'uint32' }, { name: 'postedAt', type: 'uint64' }] },
  { type: 'function', name: 'latestEpoch', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'anchorCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'poster', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'verify', stateMutability: 'view', inputs: [
    { name: 'epoch', type: 'uint64' }, { name: 'leaf', type: 'bytes32' }, { name: 'proof', type: 'bytes32[]' }], outputs: [{ type: 'bool' }] },
  { type: 'event', name: 'Anchored', anonymous: false, inputs: [
    { name: 'epoch', type: 'uint64', indexed: true }, { name: 'root', type: 'bytes32', indexed: false },
    { name: 'leafCount', type: 'uint32', indexed: false }, { name: 'snapshotURI', type: 'string', indexed: false }] },
]
export function anchorAbi() {
  const j = readJson(paths.abi())
  const abi = Array.isArray(j) ? j : Array.isArray(j?.abi) ? j.abi : null
  return abi && abi.some((x) => x.name === 'post') && abi.some((x) => x.name === 'verify') ? abi : ANCHOR_ABI_DEFAULT
}

export const dryPost = () => process.env.DRY_POST !== '0'
export const epochOf = (ms) => Math.floor(ms / 3_600_000)
export const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())
export const link = { tx: (h) => `${EXPLORER}/tx/${h}`, address: (a) => `${EXPLORER}/address/${a}` }

/** KEY=VALUE lines (export / quotes tolerated) */
export function parseEnvFile(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}
