// SQLite store (node:sqlite, WAL; the API and crawler processes share it). DATA_DIR (server/data) → fraywick.db; DB=memory for tests.
// Tables
//   servers      registry entries (latest version), one row per server id
//   probes       last probe per server (status, era, list hashes)
//   items        current state of every hashed item (tool / prompt / resource / skill / package) + body
//   item_versions every distinct (item, hash) ever seen, with first/last epoch
//   changes      diff events (added / removed / changed …) with score, label, reasons, text diff, flag tx
//   packages     npm / PyPI metadata · skills · skill_repos · hosts (politeness state) · epochs (anchors) · kv
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config.mjs'

const J = (s) => (s == null ? null : s instanceof Uint8Array ? JSON.parse(inflateRawSync(s).toString('utf8')) : JSON.parse(s))
const S = (o) => (o == null ? null : JSON.stringify(o))
/** item bodies (tool schemas…) are stored deflated; J() reads both forms */
const Z = (o) => (o == null ? null : deflateRawSync(Buffer.from(JSON.stringify(o)), { level: 6 }))

export function openStore({ memory = process.env.DB === 'memory', dir = DATA_DIR() } = {}) {
  let file = ':memory:'
  if (!memory) { mkdirSync(dir, { recursive: true }); file = join(dir, 'fraywick.db') }
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 10000;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, version TEXT, title TEXT, description TEXT, website TEXT, repository TEXT,
      remotes TEXT, packages TEXT, status TEXT, published_at TEXT, updated_at TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      removed_at INTEGER, version_changed_at INTEGER);
    CREATE TABLE IF NOT EXISTS probes (server_id TEXT PRIMARY KEY, epoch INTEGER, at INTEGER, url TEXT, remote_type TEXT, status TEXT, era TEXT,
      protocol_version TEXT, http_status INTEGER, error TEXT, ms INTEGER, server_info TEXT, capabilities TEXT, instructions_hash TEXT,
      tools_hash TEXT, prompts_hash TEXT, resources_hash TEXT, tool_count INTEGER, prompt_count INTEGER, resource_count INTEGER,
      truncated INTEGER, partial TEXT, last_ok_at INTEGER, last_ok_epoch INTEGER, auth_scheme TEXT, resource_metadata TEXT, fail_streak INTEGER NOT NULL DEFAULT 0,
      partial_kinds TEXT);
    CREATE INDEX IF NOT EXISTS probes_status ON probes(status);
    CREATE INDEX IF NOT EXISTS probes_url ON probes(url);
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, subject TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, hash TEXT NOT NULL, body TEXT,
      first_epoch INTEGER NOT NULL, last_epoch INTEGER NOT NULL, changed_epoch INTEGER, removed_epoch INTEGER);
    CREATE INDEX IF NOT EXISTS items_subject ON items(subject);
    CREATE TABLE IF NOT EXISTS item_versions (item_id TEXT NOT NULL, hash TEXT NOT NULL, body TEXT, first_epoch INTEGER NOT NULL, last_epoch INTEGER NOT NULL,
      PRIMARY KEY (item_id, hash));
    CREATE TABLE IF NOT EXISTS changes (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL, at INTEGER NOT NULL, subject TEXT NOT NULL, item_id TEXT NOT NULL,
      kind TEXT NOT NULL, change TEXT NOT NULL, old_hash TEXT, new_hash TEXT, old_body TEXT, new_body TEXT, diff TEXT, score INTEGER NOT NULL,
      label TEXT NOT NULL, reasons TEXT, flag_status TEXT, flag_tx TEXT, flag_error TEXT);
    CREATE INDEX IF NOT EXISTS changes_epoch ON changes(epoch);
    CREATE INDEX IF NOT EXISTS changes_subject ON changes(subject, id);
    CREATE INDEX IF NOT EXISTS changes_item ON changes(item_id, id);
    CREATE INDEX IF NOT EXISTS changes_label ON changes(label, id);
    CREATE TABLE IF NOT EXISTS packages (key TEXT PRIMARY KEY, eco TEXT NOT NULL, name TEXT NOT NULL, version TEXT, integrity TEXT, integrity_hash TEXT,
      maintainers TEXT, maintainers_hash TEXT, published_at TEXT, etag TEXT, status TEXT, error TEXT, checked_at INTEGER, last_ok_epoch INTEGER,
      servers TEXT, first_seen INTEGER);
    CREATE TABLE IF NOT EXISTS skills (key TEXT PRIMARY KEY, repo TEXT NOT NULL, path TEXT NOT NULL, ref TEXT, commit_sha TEXT, blob_sha TEXT, file_hash TEXT,
      size INTEGER, status TEXT, error TEXT, checked_at INTEGER, last_ok_epoch INTEGER, first_seen INTEGER);
    CREATE TABLE IF NOT EXISTS skill_repos (repo TEXT PRIMARY KEY, ref TEXT, commit_sha TEXT, commit_etag TEXT, tree TEXT, checked_at INTEGER, status TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS hosts (host TEXT PRIMARY KEY, robots TEXT, robots_at INTEGER, opted_out INTEGER NOT NULL DEFAULT 0, opt_reason TEXT,
      backoff_until INTEGER, last_status TEXT, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS epochs (epoch INTEGER PRIMARY KEY, started_at INTEGER, built_at INTEGER, root TEXT, leaf_count INTEGER, snapshot TEXT,
      snapshot_sha256 TEXT, stats TEXT, post_status TEXT, tx TEXT, block INTEGER, posted_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
  `)
  // scorer v2 (19 Oct): suppressed = 'flap' | 'volatile_repeat' | 'partial_listing' | 'rolled_up' (kept, hidden from the feed);
  // volatile = only numbers / dates / list order changed; orig_* + revised_* = re-scored after a scorer fix (on-chain flags stay)
  const ccols = new Set(db.prepare('PRAGMA table_info(changes)').all().map((c) => c.name))
  for (const [c, t] of [['suppressed', 'TEXT'], ['volatile', 'INTEGER'], ['orig_score', 'INTEGER'], ['orig_label', 'TEXT'], ['revised_note', 'TEXT'], ['revised_at', 'INTEGER'], ['scorer', 'INTEGER']])
    if (!ccols.has(c)) db.exec(`ALTER TABLE changes ADD COLUMN ${c} ${t}`)
  db.exec('CREATE INDEX IF NOT EXISTS changes_at ON changes(at)')
  const pcols = new Set(db.prepare('PRAGMA table_info(probes)').all().map((c) => c.name))
  if (!pcols.has('partial_kinds')) db.exec('ALTER TABLE probes ADD COLUMN partial_kinds TEXT')
  const q = (sql) => db.prepare(sql)
  const st = {
    getServer: q('SELECT * FROM servers WHERE id = ?'),
    putServer: q(`INSERT INTO servers (id, version, title, description, website, repository, remotes, packages, status, published_at, updated_at, first_seen, last_seen, removed_at, version_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET version_changed_at = CASE WHEN servers.version IS NOT excluded.version THEN excluded.last_seen ELSE servers.version_changed_at END,
        version = excluded.version, title = excluded.title, description = excluded.description, website = excluded.website,
        repository = excluded.repository, remotes = excluded.remotes, packages = excluded.packages, status = excluded.status, published_at = excluded.published_at,
        updated_at = excluded.updated_at, last_seen = excluded.last_seen, removed_at = NULL`),
    markRemoved: q('UPDATE servers SET removed_at = ? WHERE last_seen < ? AND removed_at IS NULL'),
    activeServers: q('SELECT * FROM servers WHERE removed_at IS NULL'),
    getProbe: q('SELECT * FROM probes WHERE server_id = ?'),
    putProbe: q(`INSERT INTO probes (server_id, epoch, at, url, remote_type, status, era, protocol_version, http_status, error, ms, server_info, capabilities, instructions_hash,
      tools_hash, prompts_hash, resources_hash, tool_count, prompt_count, resource_count, truncated, partial, last_ok_at, last_ok_epoch, auth_scheme, resource_metadata, fail_streak, partial_kinds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET epoch = excluded.epoch, at = excluded.at, url = excluded.url, remote_type = excluded.remote_type, status = excluded.status,
        era = excluded.era, protocol_version = excluded.protocol_version, http_status = excluded.http_status, error = excluded.error, ms = excluded.ms,
        server_info = COALESCE(excluded.server_info, probes.server_info), capabilities = COALESCE(excluded.capabilities, probes.capabilities),
        instructions_hash = COALESCE(excluded.instructions_hash, probes.instructions_hash),
        tools_hash = COALESCE(excluded.tools_hash, probes.tools_hash), prompts_hash = COALESCE(excluded.prompts_hash, probes.prompts_hash),
        resources_hash = COALESCE(excluded.resources_hash, probes.resources_hash), tool_count = COALESCE(excluded.tool_count, probes.tool_count),
        prompt_count = COALESCE(excluded.prompt_count, probes.prompt_count), resource_count = COALESCE(excluded.resource_count, probes.resource_count),
        truncated = excluded.truncated, partial = excluded.partial, last_ok_at = COALESCE(excluded.last_ok_at, probes.last_ok_at),
        last_ok_epoch = COALESCE(excluded.last_ok_epoch, probes.last_ok_epoch), auth_scheme = excluded.auth_scheme, resource_metadata = excluded.resource_metadata,
        fail_streak = CASE WHEN excluded.status IN ('ok', 'auth_required') THEN 0 ELSE probes.fail_streak + 1 END,
        partial_kinds = CASE WHEN excluded.status = 'ok' THEN excluded.partial_kinds ELSE probes.partial_kinds END`),
    probeStatusCounts: q('SELECT status, COUNT(*) n FROM probes WHERE epoch = ? GROUP BY status'),
    itemsOf: q('SELECT i.id, i.subject, i.kind, i.name, i.hash, COALESCE(v.body, i.body) body, i.first_epoch, i.last_epoch, i.changed_epoch, i.removed_epoch FROM items i LEFT JOIN item_versions v ON v.item_id = i.id AND v.hash = i.hash WHERE i.subject = ? ORDER BY i.kind, i.name'),
    itemsOfLite: q('SELECT id, subject, kind, name, hash, first_epoch, last_epoch, changed_epoch, removed_epoch FROM items WHERE subject = ? ORDER BY kind, name'),
    liveItemsOf: q('SELECT id, subject, kind, name, hash, first_epoch, last_epoch, changed_epoch, removed_epoch FROM items WHERE subject = ? AND removed_epoch IS NULL ORDER BY kind, name'),
    getItem: q('SELECT i.id, i.subject, i.kind, i.name, i.hash, COALESCE(v.body, i.body) body, i.first_epoch, i.last_epoch, i.changed_epoch, i.removed_epoch FROM items i LEFT JOIN item_versions v ON v.item_id = i.id AND v.hash = i.hash WHERE i.id = ?'),
    putItem: q(`INSERT INTO items (id, subject, kind, name, hash, body, first_epoch, last_epoch, changed_epoch, removed_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(id) DO UPDATE SET changed_epoch = CASE WHEN items.hash <> excluded.hash OR items.removed_epoch IS NOT NULL THEN excluded.last_epoch ELSE items.changed_epoch END,
        hash = excluded.hash, body = excluded.body, last_epoch = excluded.last_epoch, removed_epoch = NULL`),
    removeItem: q('UPDATE items SET removed_epoch = ?, changed_epoch = ? WHERE id = ? AND removed_epoch IS NULL'),
    putVersion: q(`INSERT INTO item_versions (item_id, hash, body, first_epoch, last_epoch) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_id, hash) DO UPDATE SET last_epoch = MAX(item_versions.last_epoch, excluded.last_epoch)`),
    versionsOf: q('SELECT * FROM item_versions WHERE item_id = ? ORDER BY first_epoch DESC LIMIT ?'),
    versionByHash: q('SELECT * FROM item_versions WHERE item_id = ? AND hash = ?'),
    probesByUrl: q('SELECT * FROM probes WHERE url = ? OR url = ? LIMIT 5'),
    itemCounts: q("SELECT kind, COUNT(*) n FROM items WHERE removed_epoch IS NULL GROUP BY kind"),
    putChange: q(`INSERT INTO changes (epoch, at, subject, item_id, kind, change, old_hash, new_hash, old_body, new_body, diff, score, label, reasons, suppressed, volatile, scorer)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setSuppressed: q('UPDATE changes SET suppressed = ? WHERE id = ? AND suppressed IS NULL'),
    leaving: q('SELECT id, epoch FROM changes WHERE item_id = ? AND old_hash = ? AND epoch >= ? AND suppressed IS NULL ORDER BY id DESC LIMIT 1'),
    volatileOnDay: q('SELECT id FROM changes WHERE item_id = ? AND volatile = 1 AND suppressed IS NULL AND at >= ? AND at < ? LIMIT 1'),
    lastNote: q('SELECT id FROM changes WHERE subject = ? AND change = ? AND epoch >= ? LIMIT 1'),
    recentVersion: q('SELECT last_epoch FROM item_versions WHERE item_id = ? AND hash = ? AND last_epoch >= ?'),
    getChange: q('SELECT * FROM changes WHERE id = ?'),
    feed: q('SELECT * FROM changes WHERE id < ? AND suppressed IS NULL ORDER BY id DESC LIMIT ?'),
    feedLabel: q('SELECT * FROM changes WHERE id < ? AND label = ? AND suppressed IS NULL ORDER BY id DESC LIMIT ?'),
    feedMin: q('SELECT * FROM changes WHERE id < ? AND score >= ? AND suppressed IS NULL ORDER BY id DESC LIMIT ?'),
    feedAll: q('SELECT * FROM changes WHERE id < ? ORDER BY id DESC LIMIT ?'),
    changesOfSubject: q('SELECT * FROM changes WHERE subject = ? ORDER BY id DESC LIMIT ?'),
    changesOfItem: q('SELECT * FROM changes WHERE item_id = ? ORDER BY id DESC LIMIT ?'),
    changesOfEpoch: q('SELECT * FROM changes WHERE epoch = ? ORDER BY score DESC, id ASC'),
    changesSince: q('SELECT label, COUNT(*) n FROM changes WHERE at >= ? AND suppressed IS NULL AND COALESCE(volatile, 0) = 0 GROUP BY label'),
    noiseSince: q("SELECT COALESCE(suppressed, 'volatile') k, COUNT(*) n FROM changes WHERE at >= ? AND (suppressed IS NOT NULL OR volatile = 1) GROUP BY k"),
    setFlag: q('UPDATE changes SET flag_status = ?, flag_tx = ?, flag_error = ? WHERE id = ?'),
    getPackage: q('SELECT * FROM packages WHERE key = ?'),
    putPackage: q(`INSERT INTO packages (key, eco, name, version, integrity, integrity_hash, maintainers, maintainers_hash, published_at, etag, status, error, checked_at, last_ok_epoch, servers, first_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET version = COALESCE(excluded.version, packages.version), integrity = COALESCE(excluded.integrity, packages.integrity),
        integrity_hash = COALESCE(excluded.integrity_hash, packages.integrity_hash), maintainers = COALESCE(excluded.maintainers, packages.maintainers),
        maintainers_hash = COALESCE(excluded.maintainers_hash, packages.maintainers_hash), published_at = COALESCE(excluded.published_at, packages.published_at),
        etag = COALESCE(excluded.etag, packages.etag), status = excluded.status, error = excluded.error, checked_at = excluded.checked_at,
        last_ok_epoch = COALESCE(excluded.last_ok_epoch, packages.last_ok_epoch), servers = excluded.servers`),
    packagesOk: q('SELECT * FROM packages WHERE last_ok_epoch = ? ORDER BY key'),
    allPackages: q('SELECT * FROM packages'),
    getSkill: q('SELECT * FROM skills WHERE key = ?'),
    putSkill: q(`INSERT INTO skills (key, repo, path, ref, commit_sha, blob_sha, file_hash, size, status, error, checked_at, last_ok_epoch, first_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET ref = excluded.ref, commit_sha = COALESCE(excluded.commit_sha, skills.commit_sha), blob_sha = COALESCE(excluded.blob_sha, skills.blob_sha),
        file_hash = COALESCE(excluded.file_hash, skills.file_hash), size = COALESCE(excluded.size, skills.size), status = excluded.status, error = excluded.error,
        checked_at = excluded.checked_at, last_ok_epoch = COALESCE(excluded.last_ok_epoch, skills.last_ok_epoch)`),
    skillsOk: q('SELECT * FROM skills WHERE last_ok_epoch = ? ORDER BY key'),
    allSkills: q('SELECT * FROM skills'),
    getRepo: q('SELECT * FROM skill_repos WHERE repo = ?'),
    putRepo: q(`INSERT INTO skill_repos (repo, ref, commit_sha, commit_etag, tree, checked_at, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo) DO UPDATE SET ref = excluded.ref, commit_sha = COALESCE(excluded.commit_sha, skill_repos.commit_sha), commit_etag = COALESCE(excluded.commit_etag, skill_repos.commit_etag),
        tree = COALESCE(excluded.tree, skill_repos.tree), checked_at = excluded.checked_at, status = excluded.status, error = excluded.error`),
    getHost: q('SELECT * FROM hosts WHERE host = ?'),
    putHost: q(`INSERT INTO hosts (host, robots, robots_at, opted_out, opt_reason, backoff_until, last_status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET robots = COALESCE(excluded.robots, hosts.robots), robots_at = COALESCE(excluded.robots_at, hosts.robots_at),
        opted_out = excluded.opted_out, opt_reason = excluded.opt_reason, backoff_until = excluded.backoff_until, last_status = excluded.last_status, updated_at = excluded.updated_at`),
    optedOutHosts: q('SELECT host, opt_reason, updated_at FROM hosts WHERE opted_out = 1 ORDER BY host'),
    getEpoch: q('SELECT * FROM epochs WHERE epoch = ?'),
    putEpoch: q(`INSERT INTO epochs (epoch, started_at, built_at, root, leaf_count, snapshot, snapshot_sha256, stats, post_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(epoch) DO UPDATE SET built_at = excluded.built_at, root = excluded.root, leaf_count = excluded.leaf_count, snapshot = excluded.snapshot,
        snapshot_sha256 = excluded.snapshot_sha256, stats = excluded.stats, post_status = excluded.post_status`),
    setPost: q('UPDATE epochs SET post_status = ?, tx = COALESCE(?, tx), block = COALESCE(?, block), posted_at = COALESCE(?, posted_at), error = ?, attempts = attempts + ? WHERE epoch = ?'),
    epochs: q('SELECT * FROM epochs WHERE root IS NOT NULL ORDER BY epoch DESC LIMIT ?'),
    epochsBefore: q('SELECT * FROM epochs WHERE root IS NOT NULL AND epoch < ? ORDER BY epoch DESC LIMIT ?'),
    lastBuilt: q('SELECT * FROM epochs WHERE root IS NOT NULL ORDER BY epoch DESC LIMIT 1'),
    lastConfirmed: q("SELECT * FROM epochs WHERE post_status = 'confirmed' ORDER BY epoch DESC LIMIT 1"),
    pendingPosts: q("SELECT * FROM epochs WHERE post_status IN ('pending', 'sent', 'failed') ORDER BY epoch DESC"),
    countConfirmed: q("SELECT COUNT(*) n FROM epochs WHERE post_status = 'confirmed'"),
    getKv: q('SELECT v FROM kv WHERE k = ?'),
    putKv: q('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
  }
  const row = (r, jsonCols = []) => { if (!r) return null; const o = { ...r }; for (const c of jsonCols) if (c in o) o[c] = J(o[c]); return o }

  return {
    db, J, S,
    tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } },
    close: () => db.close(),
    getServer: (id) => row(st.getServer.get(id), ['remotes', 'packages', 'repository']),
    putServer(s, now) {
      st.putServer.run(s.id, s.version ?? null, s.title ?? null, s.description ?? null, s.websiteUrl ?? null, S(s.repository), S(s.remotes || []), S(s.packages || []), s.status ?? 'active', s.publishedAt ?? null, s.updatedAt ?? null, now, now)
    },
    markRemoved: (now, seenBefore) => st.markRemoved.run(now, seenBefore).changes,
    activeServers: () => st.activeServers.all().map((r) => row(r, ['remotes', 'packages', 'repository'])),
    getProbe: (id) => row(st.getProbe.get(id), ['server_info', 'capabilities', 'partial', 'partial_kinds']),
    putProbe(p) {
      st.putProbe.run(p.serverId, p.epoch, p.at, p.url, p.remoteType, p.status, p.era ?? null, p.protocolVersion ?? null, p.httpStatus ?? null, p.error ?? null, p.ms ?? null,
        S(p.serverInfo), S(p.capabilities), p.instructionsHash ?? null, p.toolsHash ?? null, p.promptsHash ?? null, p.resourcesHash ?? null,
        p.toolCount ?? null, p.promptCount ?? null, p.resourceCount ?? null, p.truncated ? 1 : 0, S(p.partial), p.lastOkAt ?? null, p.lastOkEpoch ?? null,
        p.authScheme ?? null, p.resourceMetadata ?? null, p.status === 'ok' || p.status === 'auth_required' ? 0 : 1, S(p.partialKinds))
    },
    probeStatusCounts: (epoch) => Object.fromEntries(st.probeStatusCounts.all(epoch).map((r) => [r.status, r.n])),
    okProbes: (epoch) => db.prepare("SELECT p.*, s.version FROM probes p JOIN servers s ON s.id = p.server_id WHERE p.epoch = ? AND p.status = 'ok' ORDER BY p.server_id").all(epoch),
    itemsOf: (subject, { live = false, bodies = true } = {}) => (live ? st.liveItemsOf : bodies ? st.itemsOf : st.itemsOfLite).all(subject).map((r) => row(r, ['body'])),
    getItem: (id) => row(st.getItem.get(id), ['body']),
    putItem(it, epoch) { st.putItem.run(it.id, it.subject, it.kind, it.name, it.hash, null, epoch, epoch); st.putVersion.run(it.id, it.hash, Z(it.body), epoch, epoch) },
    removeItem: (id, epoch) => st.removeItem.run(epoch, epoch, id),
    versionsOf: (id, limit = 50) => st.versionsOf.all(id, limit).map((r) => row(r, ['body'])),
    versionByHash: (id, h) => row(st.versionByHash.get(id, h), ['body']),
    probesByUrl: (a, b) => st.probesByUrl.all(a, b).map((r) => row(r, ['server_info', 'capabilities', 'partial'])),
    itemCounts: () => Object.fromEntries(st.itemCounts.all().map((r) => [r.kind, r.n])),
    putChange(c) {
      return Number(st.putChange.run(c.epoch, c.at, c.subject, c.itemId, c.kind, c.change, c.oldHash ?? null, c.newHash ?? null, S(c.oldBody), S(c.newBody), S(c.diff),
        c.score, c.label, S(c.reasons), c.suppressed ?? null, c.volatile ? 1 : 0, c.scorer ?? null).lastInsertRowid)
    },
    setSuppressed: (id, reason) => st.setSuppressed.run(reason, id).changes,
    /** latest visible change of an item that moved away from `hash` since minEpoch */
    leaving: (itemId, hash, minEpoch) => st.leaving.get(itemId, hash, minEpoch) || null,
    volatileOnDay: (itemId, t0, t1) => !!st.volatileOnDay.get(itemId, t0, t1),
    lastNote: (subject, change, minEpoch) => !!st.lastNote.get(subject, change, minEpoch),
    recentVersion: (itemId, hash, minEpoch) => !!st.recentVersion.get(itemId, hash, minEpoch),
    noiseSince: (t) => Object.fromEntries(st.noiseSince.all(t).map((r) => [r.k, r.n])),
    getChange: (id) => row(st.getChange.get(id), ['old_body', 'new_body', 'diff', 'reasons']),
    feed: ({ before = Number.MAX_SAFE_INTEGER, label = null, minScore = null, all = false, limit = 50 } = {}) =>
      (all ? st.feedAll.all(before, limit) : label ? st.feedLabel.all(before, label, limit) : minScore != null ? st.feedMin.all(before, minScore, limit) : st.feed.all(before, limit))
        .map((r) => row(r, ['old_body', 'new_body', 'diff', 'reasons'])),
    changesOfSubject: (s, limit = 200) => st.changesOfSubject.all(s, limit).map((r) => row(r, ['old_body', 'new_body', 'diff', 'reasons'])),
    changesOfItem: (id, limit = 200) => st.changesOfItem.all(id, limit).map((r) => row(r, ['old_body', 'new_body', 'diff', 'reasons'])),
    changesOfEpoch: (e) => st.changesOfEpoch.all(e).map((r) => row(r, ['reasons'])),
    changesSince: (t) => Object.fromEntries(st.changesSince.all(t).map((r) => [r.label, r.n])),
    setFlag: (id, status, tx, error) => st.setFlag.run(status, tx ?? null, error ?? null, id),
    getPackage: (k) => row(st.getPackage.get(k), ['maintainers', 'servers']),
    putPackage(p) {
      st.putPackage.run(p.key, p.eco, p.name, p.version ?? null, p.integrity ?? null, p.integrityHash ?? null, S(p.maintainers), p.maintainersHash ?? null,
        p.publishedAt ?? null, p.etag ?? null, p.status, p.error ?? null, p.checkedAt, p.lastOkEpoch ?? null, S(p.servers || []), p.checkedAt)
    },
    packagesOk: (e) => st.packagesOk.all(e).map((r) => row(r, ['maintainers', 'servers'])),
    allPackages: () => st.allPackages.all().map((r) => row(r, ['maintainers', 'servers'])),
    getSkill: (k) => st.getSkill.get(k) || null,
    putSkill(s) {
      st.putSkill.run(s.key, s.repo, s.path, s.ref ?? null, s.commit ?? null, s.blobSha ?? null, s.fileHash ?? null, s.size ?? null, s.status, s.error ?? null, s.checkedAt, s.lastOkEpoch ?? null, s.checkedAt)
    },
    skillsOk: (e) => st.skillsOk.all(e),
    allSkills: () => st.allSkills.all(),
    getRepo: (r) => row(st.getRepo.get(r), ['tree']),
    putRepo: (r) => st.putRepo.run(r.repo, r.ref ?? null, r.commit ?? null, r.etag ?? null, S(r.tree), r.checkedAt, r.status, r.error ?? null),
    getHost: (h) => row(st.getHost.get(h), ['robots']),
    putHost: (h) => st.putHost.run(h.host, S(h.robots), h.robotsAt ?? null, h.optedOut ? 1 : 0, h.optReason ?? null, h.backoffUntil ?? null, h.lastStatus ?? null, Date.now()),
    optedOutHosts: () => st.optedOutHosts.all(),
    getEpoch: (e) => row(st.getEpoch.get(e), ['stats']),
    putEpoch: (e) => st.putEpoch.run(e.epoch, e.startedAt, e.builtAt, e.root, e.leafCount, e.snapshot, e.snapshotSha256, S(e.stats), e.postStatus),
    setPost: (epoch, { status, tx = null, block = null, postedAt = null, error = null, attempt = 0 }) => st.setPost.run(status, tx, block, postedAt, error, attempt, epoch),
    epochs: (limit = 50, before = null) => (before ? st.epochsBefore.all(before, limit) : st.epochs.all(limit)).map((r) => row(r, ['stats'])),
    lastBuilt: () => row(st.lastBuilt.get(), ['stats']),
    lastConfirmed: () => row(st.lastConfirmed.get(), ['stats']),
    pendingPosts: () => st.pendingPosts.all().map((r) => row(r, ['stats'])),
    countConfirmed: () => st.countConfirmed.get().n,
    kv: (k, v) => { if (v === undefined) { const r = st.getKv.get(k); return r ? J(r.v) : null } st.putKv.run(k, S(v)) },
  }
}
