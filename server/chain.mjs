// Robinhood Chain (4663) access for ToolAnchor: reads (anchors, latestEpoch, verify) and the poster's writes (post, flag).
// Poster key: env POSTER_PRIVATE_KEY, else /etc/fraywick/poster.env (POSTER_PRIVATE_KEY=0x…). Never logged, never returned by the API.
// DRY_POST=1 (default) never sends. NO_NETWORK=1 makes every RPC call throw.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, http, BaseError, ContractFunctionRevertedError } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anchorConfig, anchorAbi, CHAIN_ID, DEFAULT_RPC, parseEnvFile, dryPost } from './config.mjs'

export const robinhood = (url) => defineChain({ id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [url] } }, blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } } })

let cachedAccount
export function loadPoster(env = process.env) {
  if (cachedAccount !== undefined && env === process.env) return cachedAccount
  let key = env.POSTER_PRIVATE_KEY || null
  if (!key) { try { key = parseEnvFile(readFileSync(env.POSTER_ENV_FILE || '/etc/fraywick/poster.env', 'utf8')).POSTER_PRIVATE_KEY || null } catch {} }
  let acct = null
  if (key) {
    const k = key.startsWith('0x') ? key : '0x' + key
    if (/^0x[0-9a-fA-F]{64}$/.test(k)) acct = privateKeyToAccount(k)
    else console.error('chain: POSTER_PRIVATE_KEY is malformed (value not shown)')
  }
  if (env === process.env) cachedAccount = acct
  return acct
}

export const errName = (e) => {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError)
    if (r?.data?.errorName) return r.data.errorName
    return (e.shortMessage || e.message).slice(0, 200)
  }
  return String(e?.message || e).slice(0, 200)
}

export function createChain({ rpcUrl = process.env.RPC_URL || DEFAULT_RPC, account, clients } = {}) {
  const chain = robinhood(rpcUrl)
  const offline = () => { if (process.env.NO_NETWORK === '1' && !clients) throw new Error('network disabled (NO_NETWORK=1)') }
  let pub, wallet
  const getPub = () => { offline(); return clients?.pub || (pub ||= createPublicClient({ chain, transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) })) }
  const poster = () => (account === undefined ? loadPoster() : account)
  const getWallet = () => { offline(); return clients?.wallet || (wallet ||= createWalletClient({ chain, account: poster(), transport: http(rpcUrl, { timeout: 20_000, retryCount: 1 }) })) }
  const addr = () => anchorConfig().address
  const read = (functionName, args = []) => getPub().readContract({ address: addr(), abi: anchorAbi(), functionName, args })

  return {
    rpcUrl,
    address: addr,
    posterAddress: () => poster()?.address || null,
    /** sending is possible: not dry, contract known, key loaded */
    canSend: () => !dryPost() && !!addr() && !!poster(),
    async anchorOf(epoch) {
      const r = await read('anchors', [BigInt(epoch)])
      const [root, leafCount, postedAt] = Array.isArray(r) ? r : [r.root, r.leafCount, r.postedAt]
      return { root, leafCount: Number(leafCount), postedAt: Number(postedAt) }
    },
    latestEpoch: async () => Number(await read('latestEpoch')),
    anchorCount: async () => Number(await read('anchorCount')),
    onChainPoster: async () => read('poster'),
    verify: (epoch, leaf, proof) => read('verify', [BigInt(epoch), leaf, proof]),
    async balance() { const a = poster()?.address; return a ? await getPub().getBalance({ address: a }) : null },
    /** simulate + send + wait; returns { hash, block } or throws with a contract error name */
    async write(functionName, args, { waitMs = 120_000 } = {}) {
      if (!this.canSend()) throw new Error(dryPost() ? 'DRY_POST is on' : !addr() ? 'no ToolAnchor address' : 'no poster key')
      const p = getPub(), w = getWallet()
      const { request } = await p.simulateContract({ address: addr(), abi: anchorAbi(), functionName, args, account: poster() })
      const hash = await w.writeContract(request)
      const rc = await p.waitForTransactionReceipt({ hash, timeout: waitMs, pollingInterval: 2_000 }).catch((e) => ({ pendingError: e }))
      if (rc.pendingError) return { hash, block: null, pending: true }
      if (rc.status !== 'success') throw Object.assign(new Error(`reverted in tx ${hash}`), { hash })
      return { hash, block: Number(rc.blockNumber) }
    },
    receipt: async (hash) => getPub().getTransactionReceipt({ hash }).catch(() => null),
  }
}
