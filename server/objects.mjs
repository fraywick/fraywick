// Content-addressed objects served at /snapshots/objects/<hash>.<ext>: the exact bytes whose keccak256 is <hash>
// (JCS JSON for tools / prompts / resources / maintainer lists, raw bytes for SKILL.md and integrity strings).
// Snapshots list item hashes; anyone can fetch an object, hash it, and recompute every list hash and leaf.
import { mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize } from './lib/jcs.mjs'
import { paths } from './config.mjs'

const known = new Set()
let dir = null
export const objectsDir = () => join(paths.snapshots(), 'objects')

export function writeObject(hash, value, ext = 'json') {
  if (process.env.NO_OBJECTS === '1' || !/^0x[0-9a-f]{64}$/.test(hash)) return
  const name = `${hash.slice(2)}.${ext}`
  if (known.has(name)) return
  const d = objectsDir()
  if (dir !== d) { mkdirSync(d, { recursive: true }); dir = d }
  const file = join(d, name)
  if (!existsSync(file)) {
    const data = ext === 'json' ? canonicalize(value) : Buffer.isBuffer(value) || value instanceof Uint8Array ? value : String(value)
    const tmp = file + '.tmp' + process.pid
    writeFileSync(tmp, data)
    renameSync(tmp, file)
  }
  known.add(name)
}
