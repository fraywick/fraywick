# ToolAnchor

The on-chain half of FRAYWICK, on Robinhood Chain (chain id 4663). Every hour FRAYWICK hashes the tool
definitions of public MCP servers, Agent Skills and package metadata, builds one merkle tree, and posts its root
here. Anyone can later prove that a given definition was (or was not) what FRAYWICK saw in a given hour.

- Stores one `{root, leafCount, postedAt}` per epoch. Epoch = UTC hour number (`unix / 3600`).
- Holds no funds, has no token logic, no upgradeability. It only stores roots and emits events.
- `Anchored(uint64 indexed epoch, bytes32 root, uint32 leafCount, string snapshotURI)` for every root. The
  snapshot at `snapshotURI` holds every leaf, so anyone can rebuild the tree.
- `Flagged(uint64 indexed epoch, bytes32 indexed subject, bytes32 oldHash, bytes32 newHash, uint8 severity, string note)`
  for changes the heuristic scored `suspicious`. Event only; the epoch must already be anchored. A flag describes a
  diff, it is not a verdict about a project.

## Who can do what

| Role | Address | Rights |
|---|---|---|
| owner | `0x26c22014016BE6B55F00E6BBb8C5058801404092` (creator wallet) | `setPoster`, two-step `transferOwnership` / `acceptOwnership` |
| poster | `0x3D0d1B5dfe2f5004640A42595EbCff5fE3dE59eC` (FRAYWICK server key) | `post`, `flag` |
| deployer | `0x75dDeCCA5d425aD470780e24700b7690676d44Bf` | none (only paid gas) |

Owner and poster are constructor arguments. `renounceOwnership` is disabled so the poster can always be rotated.

Rules enforced by `post`:
- `epoch` strictly greater than `latestEpoch()` (gaps are allowed, an older or equal epoch can never be posted,
  so a root can never be replaced),
- `epoch * 3600 <= block.timestamp` (the hour has started),
- `root != 0`.

What the contract cannot tell you: whether the poster hashed honestly. It proves *when* FRAYWICK committed to a
hash. Recompute the hash yourself from the target (see the FRAYWICK docs for the exact hashing) and compare.

## Views

- `anchors(uint64 epoch) → (bytes32 root, uint32 leafCount, uint64 postedAt)`; `root == 0` means not anchored.
- `latestEpoch() → uint64`, `anchorCount() → uint32`, `poster()`, `owner()`, `pendingOwner()`.
- `verify(uint64 epoch, bytes32 leaf, bytes32[] proof) → bool`: OpenZeppelin `MerkleProof` with sorted pairs.
  Returns `false` for an unanchored epoch.
- `leafHash(string key, string version, bytes32 h1, bytes32 h2, bytes32 h3) → bytes32`: the leaf hash for the
  FRAYWICK leaf encoding, so you can check your own encoding against the chain.

## Verify an anchor yourself

Trees are `StandardMerkleTree` from `@openzeppelin/merkle-tree` with leaf encoding
`["string","string","bytes32","bytes32","bytes32"]`:

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(key, version, h1, h2, h3))))
```

1. Get the leaf values and proof: `GET /api/proof?epoch=<epoch>&leafKey=<key>` (or take the leaf from
   `/snapshots/<epoch>.json` and build the proof yourself with the library).
2. Recompute the hashes from the live target (or use `npx fraywick verify ...`).
3. Ask the chain:

```sh
cast call <ToolAnchor> "anchors(uint64)(bytes32,uint32,uint64)" <epoch> --rpc-url https://robinhood-rpc.publicnode.com
cast call <ToolAnchor> "leafHash(string,string,bytes32,bytes32,bytes32)(bytes32)" "<key>" "<version>" <h1> <h2> <h3> \
  --rpc-url https://robinhood-rpc.publicnode.com
cast call <ToolAnchor> "verify(uint64,bytes32,bytes32[])(bool)" <epoch> <leaf> "[<p0>,<p1>,...]" \
  --rpc-url https://robinhood-rpc.publicnode.com
```

The contract address is in [`deployments/robinhood.json`](deployments/robinhood.json) once deployed; the ABI is
[`abi/ToolAnchor.json`](abi/ToolAnchor.json).

## Build and test

Requires [Foundry](https://getfoundry.sh). OpenZeppelin Contracts v5.4.0 and forge-std are vendored in `lib/`
(no submodules). Solidity 0.8.28, EVM cancun, optimizer 10000 runs.

```sh
forge build
forge test
forge test --gas-report
```

`test/vectors/merkle.json` (a `StandardMerkleTree` `dump()` produced by the FRAYWICK server's JS code) is checked
by `test_vectors_serverJsTree`; the test is skipped when the file is missing.

## Deploy

```sh
forge script script/Deploy.s.sol \
  --rpc-url https://robinhood-rpc.publicnode.com \
  --broadcast --private-key <deployer key>
```

Optional env: `OWNER`, `POSTER` (default to the addresses above), `DEPLOY_OUT`. The script refuses zero addresses
and refuses `OWNER` or `POSTER` equal to the deployer, checks owner/poster after deploy, and writes
`deployments/robinhood.json` `{address, chainId, block, owner, poster, deployer}`. `block` is the L2 head read just
before the deploy (on Robinhood Chain `block.number` inside the EVM is the L1 block).

## Verify source (Sourcify)

The Robinhood Chain Blockscout API sits behind Cloudflare and rejects scripted calls, so verify on Sourcify:

```sh
forge verify-contract <ToolAnchor> src/ToolAnchor.sol:ToolAnchor \
  --chain 4663 --verifier sourcify \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
    0x26c22014016BE6B55F00E6BBb8C5058801404092 0x3D0d1B5dfe2f5004640A42595EbCff5fE3dE59eC)
```

Check: `https://repo.sourcify.dev/4663/<ToolAnchor>` (or `curl https://sourcify.dev/server/v2/contract/4663/<ToolAnchor>`).
