# FRAYWICK server

Reads public MCP tool definitions, Agent Skills and package metadata, hashes every definition, and anchors one merkle root per UTC
hour on Robinhood Chain (chain id 4663) in `ToolAnchor`. It never runs, installs or calls anything it watches.

Node ≥ 22.13 (ESM, `node:sqlite`), dependencies: `viem`, `@openzeppelin/merkle-tree`.

```
npm ci
npm test                     # offline (NO_NETWORK=1), local fake servers only
npm run dev                  # API + crawler + dev placeholder page on :4892, data in ./data-dev, DRY_POST
node crawl-once.mjs          # one real crawl + snapshot (DRY_POST forced), uses DATA_DIR
```

## Processes

`index.mjs` with `ROLE=api` (HTTP API + `/mcp`) or `ROLE=crawler` (registry sync, probes, epochs, poster); `ROLE=all` for local dev.
Production runs both as `fraywick-api.service` and `fraywick-crawler.service`, sharing `data/fraywick.db` (WAL).

Crawler schedule: registry incremental sync (`updated_since`) every 10 min, full sync every 24 h (resumable; servers missing from a
completed full sync are marked removed). At minute :05 of each UTC hour: probe due remotes until :50, npm/PyPI metadata, skills,
diff engine, snapshot, post, flags.

## Hashing (exact)

- **JCS**: RFC 8785 (`lib/jcs.mjs`): keys sorted by UTF-16 code units, ECMAScript number form, JSON string escaping; NaN/Infinity and
  lone surrogates are rejected (such an item is skipped).
- **Item views** (only these keys, a key that is absent is omitted; a key present with `null` is kept):
  - tool `{name, title, description, inputSchema, outputSchema, annotations}`
  - prompt `{name, title, description, arguments}`
  - resource `{uri, name, title, description, mimeType}`
- **Item hash** = `keccak256(utf8(JCS(view)))`.
- **List hash** (`toolsHash`, `promptsHash`, `resourcesHash`) = `keccak256(concat(sorted item hashes))`, each hash as 32 raw bytes,
  sorted ascending. An empty list is `keccak256(0x)` = `0xc5d2…a470`. A list the server does not advertise in its capabilities (or
  that could not be read) is `bytes32(0)`.
- **Leaf values**, one encoding for all: `["string","string","bytes32","bytes32","bytes32"]`
  - server `[registryName, registryVersion, toolsHash, promptsHash, resourcesHash]`
  - skill `["skill:" + owner/repo + ":" + path, commitSha, keccak256(raw SKILL.md bytes), 0x0, 0x0]`
  - package `["npm:" + name | "pypi:" + normalizedName, version, integrityHash, maintainersHash, 0x0]`
    - npm: `integrityHash = keccak256(utf8(dist.integrity))` of the `latest` dist-tag
    - PyPI: `integrityHash = keccak256(utf8(join("\n", sorted unique "sha256:<hex>" of every file of the latest release)))`
    - `maintainersHash = keccak256(utf8(JCS(sorted unique maintainer names)))` (npm `maintainers[].name`; PyPI author/maintainer
      names, e-mail addresses stripped)
    - names: npm lowercased; PyPI lowercased with runs of `-_.` → `-`
  - FRAYWICK's own `/mcp` tools are a server leaf with key `fraywick:self` (we are watched too).
- **Leaf hash** = `keccak256(bytes.concat(keccak256(abi.encode(values))))` — `@openzeppelin/merkle-tree` `StandardMerkleTree`
  (sorted leaves, sorted pairs); `ToolAnchor.verify(epoch, leaf, proof)` uses OZ `MerkleProof.verify`.
- **Epoch** = UTC hour number `floor(unix / 3600)`. A leaf is in epoch E only if it was observed during E's crawl (no carry-over):
  a server that was down or required auth that hour has no leaf.

Test vectors: `test/vectors/merkle.json` (`npm run vectors` regenerates; `test/hash.test.mjs` checks it).

## Snapshots

`data/snapshots/<epoch>.json.gz`, served as `/snapshots/<epoch>.json`:
`{format, epoch, root, leafCount, encoding, hashing, stats, changes, leaves: [{k, t, v, h, d}]}` where `v` = leaf values, `h` = leaf hash,
`d` = detail (server: remote URL, era, `[name, itemHash]` per tool / prompt / resource; skill: repo, path, blob sha; package: integrity,
maintainers). Every item body is stored once, content-addressed, at `/snapshots/objects/<hash without 0x>.json` (the exact JCS bytes)
or `.txt` (raw SKILL.md bytes, integrity strings): `keccak256(file) == hash`, so anyone can recompute every list hash, leaf and root.

## Diff engine and score

Each observation is compared with the last *observed* state of the same subject (not just the previous epoch): `added`, `removed`,
`changed` per item; only the kinds actually read are compared (an unreadable prompts list is not "all prompts removed"); the first
observation of a subject is a silent baseline. `changed` keeps both bodies and a word / line diff.

Score 0–100 counts only what is new in the item (`score.mjs`): imperative instructions aimed at the model (`ignore previous`,
`before using this tool`, `do not tell the user`, `always call`, `<IMPORTANT>`-style tags, overrides, tool shadowing, exfiltration
phrasing, secret reads) +30 each (max 60) · hidden / zero-width / bidi / tag unicode +40 · new URL hosts +15 each (max 30; +5 each, max 10, on a newly added tool), +15 for
tunnel / paste / webhook services or raw IPs · sensitive paths and terms (`~/.ssh`, `id_rsa`, `.env`, cloud credentials, wallet,
private key, seed phrase …) +20 each (max 40) · new parameters named like `notes`, `context`, `sidenote`, `feedback` … +25 each (max 40; +15, max 30, on a newly added tool) ·
`curl | sh` style commands +25 · description length jump +15/+25 · schema changes +5/+3 · widened annotations +15 · removed item 20 ·
packages: new version 5, maintainers changed 40 (+20 if all replaced), new publisher 20, same version with new bytes 60.
Labels: `< 20 cosmetic`, `20–59 behavior`, `≥ 60 suspicious`. Suspicious changes are flagged on chain with `flag()` (max 10 per epoch);
the on-chain note carries only our label, score and reason codes. Labels describe the diff, they do not accuse anyone.

## API

See the header of `api.mjs`. `POST /api/check {target}` fetches the target live through the SSRF guard (`net.mjs`): https only, ports
443/8443, DNS resolved once and every address must be public (IPv4 + IPv6, mapped / NAT64 / 6to4 forms included), the socket connects to
the checked address, every redirect hop (max 3) is checked again, 2 MB cap after decompression, 10 s total, per-IP rate limit.
The crawler uses the same guard (registry data is hostile too) with http allowed and a few service ports denied.

`POST /mcp` is a read-only MCP server (2026-07-28 stateless + legacy handshake) with `check_server`, `check_skill`,
`recent_changes`, `get_proof`. Results given to agents contain hashes, names (sanitized), scores and reason codes only — never the
raw text of other servers' tools.

## Bot

User agent `FraywickBot/1.0 (+https://<domain>/docs#bot)`. Per remote: `server/discover` (modern) or `initialize` →
`notifications/initialized` → `tools/list` (+ `prompts/list`, `resources/list` when advertised) → session `DELETE`; never `tools/call`,
never credentials. Concurrency 16 hosts, one request chain per host, 1 s between servers on the same host, at most 240 servers per host
per hour (big hosts rotate). Back-off: auth-required servers every 6 h, failing servers 2–24 h, HTTP 429 pauses the host
(Retry-After, 10 min–6 h). Opt-out: a `robots.txt` group for `FraywickBot` disallowing the MCP path, or a host listed in
`sources/optout.json`; opted-out hosts are recorded and skipped.
