// One crawl + epoch build from the command line (integration test / manual run). Never posts: DRY_POST is forced on.
//   node crawl-once.mjs [--registry=full|incremental|skip] [--no-skills] [--no-packages] [--limit=N] [--minutes=M]
// --minutes is the probe budget, counted after the registry sync. Uses DATA_DIR (default server/data).
process.env.DRY_POST = '1'
const { openStore } = await import('./store.mjs')
const { syncRegistry, crawlEpoch } = await import('./crawl.mjs')
const { buildEpoch } = await import('./epoch.mjs')
const { epochOf } = await import('./config.mjs')

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : process.argv.includes(`--${k}`) ? true : d }

async function main() {
  const store = openStore()
  const t0 = Date.now()
  const epoch = epochOf(t0)
  const reg = arg('registry', store.kv('registry_full_at') ? 'incremental' : 'full')
  if (reg !== 'skip') console.log('registry', JSON.stringify(await syncRegistry({ store, full: reg === 'full' })))
  const minutes = Number(arg('minutes', 45))
  const stats = await crawlEpoch({ store, epoch, deadline: Date.now() + minutes * 60_000, limit: Number(arg('limit', Infinity)), packages: !arg('no-packages', false), skills: !arg('no-skills', false) })
  const built = buildEpoch(store, epoch, { stats })
  console.log(JSON.stringify({ epoch, built, stats, items: store.itemCounts(), totalMs: Date.now() - t0 }, null, 2))
  store.close()
}
// keeps the event loop alive and turns a hang into a clear error instead of "unsettled top-level await"
const watchdog = setTimeout(() => { console.error('crawl-once: still running after the time budget + 60 min, giving up'); process.exit(3) }, (Number(arg('minutes', 45)) + 90) * 60_000)
main().then(() => { clearTimeout(watchdog); process.exit(0) }, (e) => { console.error(e.stack || e.message); process.exit(1) })
