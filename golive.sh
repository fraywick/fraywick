#!/usr/bin/env bash
# Launch day: put the token live everywhere in one go (the lead runs this with the user at T0; agents never deploy).
#   ./golive.sh 0xTOKEN [SYMBOL] [PONS_TOKEN_URL]
#   SYMBOL defaults to the one-line .ticker file (never printed here). env: DRY=1 (checks only) · RPC (default publicnode) ·
#   DOMAIN (default .deploy-domain, else fraywick.xyz)
# Chain checks on Robinhood Chain (always run; there is no skip switch): the contract has code, its symbol() equals SYMBOL, decimals()
# is read, and the Pons V2 factory 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e knows the token (getLaunchedToken(token)). Then writes
# web/token.json "ca" + "symbol" (+ "decimals", "pons_token_url") and runs ./deploy.sh --web. The server re-reads token.json every
# 30 s, so it leaves preview mode without a restart; /api/health then reports "mode":"live".
set -euo pipefail
cd "$(dirname "$0")"
CA=${1:?usage: ./golive.sh 0xTOKEN_ADDRESS [SYMBOL] [PONS_TOKEN_URL]}
[[ $CA =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "✗ not a contract address: $CA"; exit 1; }
[[ $(echo "$CA" | tr '[:upper:]' '[:lower:]') != 0x0000000000000000000000000000000000000000 ]] || { echo "✗ that is the zero address"; exit 1; }
SYMBOL=${2:-$(tr -d '[:space:]' < .ticker 2>/dev/null || true)}; SYMBOL=${SYMBOL#\$}
[[ -n "$SYMBOL" ]] || { echo "✗ no SYMBOL argument and no .ticker file"; exit 1; }
[[ "$SYMBOL" =~ ^[A-Za-z0-9]{1,16}$ ]] || { echo "✗ SYMBOL must be 1–16 letters/digits"; exit 1; }
PONS_URL=${3:-https://www.ponsfamily.com/launchpad/$CA}
DOMAIN=${DOMAIN:-$(cat .deploy-domain 2>/dev/null || echo fraywick.xyz)}; DOMAIN=$(echo "$DOMAIN" | tr -d '[:space:]')
export RPC=${RPC:-https://robinhood-rpc.publicnode.com}
[[ -d server/node_modules/viem ]] || (cd server && npm ci --no-audit --no-fund --silent)

echo "→ checking $CA on Robinhood Chain ($RPC)"
# prints "decimals" on success; exits 1 with a reason otherwise. The symbol is compared inside node and never printed.
DEC=$(cd server && EXPECT="$SYMBOL" node --input-type=module - "$CA" <<'JS'
import { createPublicClient, http, parseAbi, getAddress, toFunctionSelector } from 'viem'
const ca = getAddress(process.argv[2])
const c = createPublicClient({ transport: http(process.env.RPC, { timeout: 20_000 }) })
const fail = (m) => { console.error('✗ ' + m); process.exit(1) }
if ((await c.getChainId()) !== 4663) fail('RPC is not Robinhood Chain (4663)')
const code = await c.getCode({ address: ca })
if (!code || code === '0x') fail('no contract at that address (not launched yet? wrong CA?)')
const erc = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])
const sym = await c.readContract({ address: ca, abi: erc, functionName: 'symbol' }).catch(() => fail('symbol() reverted'))
if (String(sym).toLowerCase() !== String(process.env.EXPECT).toLowerCase()) fail('symbol() on chain does not match the expected ticker (wrong CA?)')
const dec = await c.readContract({ address: ca, abi: erc, functionName: 'decimals' }).catch(() => fail('decimals() reverted'))
console.error('   ✓ token exists, symbol matches, decimals ' + dec)
// Pons V2 factory: getLaunchedToken(address) → 15-word launch record, word 14 = "exists" (same decoding as 180 pons.mjs)
const data = toFunctionSelector('getLaunchedToken(address)') + ca.slice(2).toLowerCase().padStart(64, '0')
const rec = await c.call({ to: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', data }).then((r) => r.data || '0x').catch(() => '0x')
if (rec.length >= 2 + 64 * 15 && BigInt('0x' + rec.slice(2 + 64 * 14, 2 + 64 * 15)) !== 0n) console.error('   ✓ Pons V2 launch record found')
else console.error('   ! the Pons V2 factory does not list this token (fine only if it launched elsewhere; check the Buy link)')
process.stdout.write(String(dec))
JS
)
[ "${DRY:-0}" = "1" ] && { echo "→ DRY=1: nothing written or deployed"; exit 0; }

node - "$CA" "$SYMBOL" "$DEC" "$PONS_URL" <<'JS'
const fs = require('fs')
const [ca, symbol, dec, ponsUrl] = process.argv.slice(2)
const t = JSON.parse(fs.readFileSync('web/token.json', 'utf8'))
t.ca = ca; t.symbol = symbol
if (/^\d+$/.test(dec) && Number(dec) !== t.decimals) t.decimals = Number(dec)
if (ponsUrl) t.pons_token_url = ponsUrl
fs.writeFileSync('web/token.json', JSON.stringify(t, null, 2) + '\n')
console.log(`→ token.json: ca ${t.ca} · symbol set · decimals ${t.decimals ?? 18} · launch_at ${t.launch_at} · buy ${t.pons_token_url}`)
JS
./deploy.sh --web
sleep 2
live=$(curl -s -m 20 "https://$DOMAIN/token.json?$(date +%s)" || true)
echo "$live" | grep -qi "$CA" && echo "   ✓ live token.json has the CA" || { echo "   ✗ live token.json lacks the CA"; exit 1; }
mode=""
for i in $(seq 1 25); do
  mode=$(curl -fsS -m 10 "https://$DOMAIN/api/health" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).mode)}catch{}})' || true)
  [ "$mode" = live ] && { echo "   ✓ API mode: live"; break; }
  sleep 2
done
[ "$mode" = live ] || echo "   ! API still reports '${mode:-?}' — check TOKEN_JSON in the unit, or: ssh us1 systemctl restart fraywick-api"
code=$(curl -s -o /dev/null -L -m 20 -w '%{http_code}' -A 'Mozilla/5.0' "$PONS_URL" || true)
echo "   Buy page $PONS_URL → HTTP $code"
