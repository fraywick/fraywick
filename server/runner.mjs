// Crawler loop (ROLE=crawler or all).
//   registry sync: incremental (updated_since) every 10 min, full every 24 h (also on first start)
//   epoch cycle:   at minute :05 of every UTC hour (or on start, if this hour's epoch is not built yet and it is before :50):
//                  crawl (probe deadline :50) → build snapshot → post root (DRY_POST=1 default) → flags
//   poster tick:   every 30 s retries a pending / failed post of the newest epoch (never an older one)
import { syncRegistry, crawlEpoch } from './crawl.mjs'
import { buildEpoch, createPoster } from './epoch.mjs'
import { epochOf, dryPost } from './config.mjs'

export function createRunner({ store, chain, log = console, now = () => Date.now() }) {
  const poster = createPoster({ store, chain, log, now })
  let cycleBusy = false, regBusy = null, stopped = false, lastStarted = null
  const timers = []
  const state = (patch) => store.kv('crawler_state', { ...(store.kv('crawler_state') || {}), ...patch, updatedAt: new Date(now()).toISOString() })

  function registryTick() {
    if (regBusy || stopped) return regBusy || Promise.resolve()
    regBusy = registrySync().finally(() => { regBusy = null })
    return regBusy
  }
  async function registrySync() {
    try {
      const fullAt = store.kv('registry_full_at')
      const full = !fullAt || now() - fullAt > 24 * 3_600_000
      const r = await syncRegistry({ store, full, log, now: now() })
      log.log?.(`registry ${r.full ? 'full' : 'incremental'}: ${r.servers} servers in ${Math.round(r.ms / 1000)} s${r.removed ? `, ${r.removed} removed` : ''}`)
    } catch (e) { log.error?.(`registry: ${e.message}`) }
  }

  async function cycle(epoch) {
    cycleBusy = true
    const t0 = now()
    state({ phase: 'crawling', epoch, startedAt: new Date(t0).toISOString() })
    try {
      if (!store.kv('registry_full_at')) await registryTick()
      const deadline = epoch * 3_600_000 + 50 * 60_000
      if (now() > deadline - 15 * 60_000) {
        log.log?.(`epoch ${epoch}: too late in the hour to crawl (first registry sync took long) — waiting for the next hour`)
        state({ phase: 'idle', skippedEpoch: epoch })
        return
      }
      const stats = await crawlEpoch({ store, epoch, log, deadline, now })
      store.kv('crawl_last', { epoch, at: new Date(now()).toISOString(), ms: stats.ms, remotes: stats.remotes, packages: stats.packages, skills: stats.skills && { skills: stats.skills.skills, repos: stats.skills.repos, changes: stats.skills.changes, repoErrors: stats.skills.repoErrors } })
      const latest = epochOf(now())
      if (latest > epoch + 1) { log.error?.(`epoch ${epoch}: crawl overran into epoch ${latest}; building anyway (posting stays monotonic)`) }
      const b = buildEpoch(store, epoch, { stats, now: now() })
      log.log?.(`epoch ${epoch}: root ${b.root} · ${b.leafCount} leaves · snapshot ${(b.bytes / 1e6).toFixed(1)} MB gz · ${Math.round((now() - t0) / 1000)} s${dryPost() ? ' · DRY_POST' : ''}`)
      state({ phase: 'idle', lastEpoch: epoch, lastMs: now() - t0 })
      await poster.tick()
    } catch (e) {
      log.error?.(`epoch ${epoch}: ${e.stack || e.message}`)
      state({ phase: 'idle', lastError: String(e.message).slice(0, 200) })
    } finally { cycleBusy = false }
  }

  function due() {
    if (cycleBusy || stopped) return
    const t = now()
    const epoch = epochOf(t)
    const minute = (t % 3_600_000) / 60_000
    if (minute < 5 || minute >= 50) return
    const row = store.getEpoch(epoch)
    if (row?.root || lastStarted === epoch) return
    lastStarted = epoch
    cycle(epoch)
  }

  return {
    start() {
      registryTick().then(due)
      timers.push(setInterval(registryTick, 10 * 60_000))
      timers.push(setInterval(due, 20_000))
      timers.push(setInterval(() => { if (!cycleBusy) poster.tick() }, 30_000))
    },
    stop() { stopped = true; for (const t of timers) clearInterval(t) },
    cycle, poster,
  }
}
