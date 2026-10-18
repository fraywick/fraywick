# FRAYWICK

**Every rug frays before it's pulled.**

FRAYWICK is a public watchtower for MCP servers and Agent Skills. Every hour it reads the tool definitions of the public MCP
servers in the official registry, popular `SKILL.md` files and their npm/PyPI package metadata, hashes every definition, and
stamps one merkle root per hour on **Robinhood Chain** (chain id 4663). When a tool's description or schema changes after people
trusted it (tool poisoning, the "MCP rug pull"), FRAYWICK shows the diff, scores it, and anyone can prove from the chain *when* it
changed. It routes nothing and runs nothing: it only reads and stamps.

- Site: https://fraywick.xyz · feed https://fraywick.xyz/feed · proofs https://fraywick.xyz/proof · docs https://fraywick.xyz/docs
- Contract: `ToolAnchor` [`0xdE841BaA3f9158C0b8E064cfF8ce124C864986B3`](https://robinhoodchain.blockscout.com/address/0xdE841BaA3f9158C0b8E064cfF8ce124C864986B3)
  on Robinhood Chain, source verified (Sourcify exact match).
- Read-only MCP endpoint for agents: `POST https://fraywick.xyz/mcp` (tools `check_server`, `check_skill`, `recent_changes`, `get_proof`).

## Verify it yourself
1. Download any hour's snapshot: `https://fraywick.xyz/snapshots/<epoch>.json` (epoch = UTC hour number, `unix / 3600`).
2. Rebuild the tree with `@openzeppelin/merkle-tree` `StandardMerkleTree.of(snapshot.leaves.map(l => l.v), snapshot.encoding)`.
3. Compare `tree.root` with `anchors(epoch)` on the contract, or check one item with `verify(epoch, leaf, proof)`.
4. Or use the CLI: `node cli/bin/fraywick.mjs verify <mcp-url | npm:pkg | pypi:pkg | SKILL.md url>`; it fetches the target,
   hashes it locally, fetches the proof and calls `verify()` on Robinhood Chain.

The exact hashing (RFC 8785 JCS → keccak256, leaf encoding `[string, string, bytes32, bytes32, bytes32]`) is documented in
[`server/README.md`](server/README.md) and on https://fraywick.xyz/docs#hashing.

## Layout
| path | what |
|---|---|
| `contracts/` | Foundry project: `ToolAnchor.sol`, tests (incl. JS ↔ Solidity merkle vectors), deploy script, ABI, deployment record |
| `server/` | Node 22 crawler (registry ingest, MCP probe, npm/PyPI metadata, skills), hashing, diff + scorer, hourly epoch + poster, API, `/mcp` |
| `cli/` | `fraywick verify` command-line verifier |
| `web/` | static site (three.js, no bundler) |
| `deploy/`, `deploy.sh` | systemd units, nginx config, provisioning and deploy scripts |

## Bot policy
User agent `FraywickBot/1.0 (+https://fraywick.xyz/docs#bot)`. We only call listing methods (`tools/list`, `prompts/list`,
`resources/list`), never `tools/call`, never send credentials, never install or run any package or skill. robots.txt groups naming
`FraywickBot` are honoured; to opt out, see https://fraywick.xyz/docs#bot.

## License
MIT
