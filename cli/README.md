# fraywick

Check that a remote MCP server, an Agent Skill or a package still matches what FRAYWICK anchored on Robinhood Chain.

```
npx fraywick verify https://mcp.example.com/mcp
npx fraywick verify npm:@modelcontextprotocol/server-everything
npx fraywick verify pypi:mcp-server-fetch
npx fraywick verify https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md --epoch 493210
```

What it does, on your machine:

1. fetches the target itself — MCP servers are only asked for `tools/list` / `prompts/list` / `resources/list` (no credentials,
   no tool calls), packages only for registry metadata, skills only as text; nothing is installed or executed;
2. recomputes the hashes locally (RFC 8785 JCS + keccak256, same code as the server);
3. gets the leaf and merkle proof for the latest (or `--epoch`) anchor from the FRAYWICK API;
4. checks the proof locally and calls `ToolAnchor.verify(epoch, leaf, proof)` and `anchors(epoch)` on Robinhood Chain
   (`https://robinhood-rpc.publicnode.com` by default).

Exit code `0` = matches the anchor and the chain confirms it · `1` = changed since the anchor (or the proof does not verify) ·
`2` = could not check (not tracked, unreachable, no anchor yet).

Options: `--api URL`, `--anchor 0x…` (pin the contract), `--rpc URL`, `--epoch N`, `--json`. Defaults come from `config.json`
(env `FRAYWICK_API`, `FRAYWICK_ANCHOR`, `FRAYWICK_RPC` override).
