#!/usr/bin/env bash
# Ship FRAYWICK to the VPS: ticker leak guard → checks + offline tests → rsync web/ + server/ + contract JSON → npm ci → restart both
# units → health check.
#   ./deploy.sh            full deploy
#   ./deploy.sh --web      static files only (no restart)
#   ./deploy.sh --check    leak guard + checks + offline tests only (nothing leaves this machine)
# One-time setup first: ./deploy/provision.sh (port 4891 unless `ss -ltnp` shows it taken). HOST/DOMAIN default to .deploy-host /
# .deploy-domain. The lead runs this; agents never deploy.
#
# Never shipped: .ticker, secrets/, server/data*, server/test, server/dev-web, server/node_modules (rebuilt with npm ci), cli/ (npm).
# Keys live only in /etc/fraywick/*.env on the VPS (filled by hand, see STATUS-SERVER.md "Keys").
#
# Ticker leak guard (BRIEF "Identity"): the secret ticker lives only in the untracked file .ticker (project root, never rsynced).
# While web/token.json "symbol" is null, everything public (web/, server/ minus node_modules/ and data/, cli/, contracts/deployments,
# contracts/abi) is grepped case-insensitively for the bare ticker as a whole word (which also catches "$TICKER"); any hit aborts.
# Only file names are printed, never the value. NO_TICKER_GUARD=1 skips the guard when .ticker is missing (not recommended).
set -euo pipefail
cd "$(dirname "$0")"
HOST=${HOST:-$(cat .deploy-host 2>/dev/null || echo us1)}
HOST=$(echo "$HOST" | tr -d '[:space:]')
DOMAIN=${DOMAIN:-$(cat .deploy-domain 2>/dev/null || true)}
DOMAIN=$(echo "$DOMAIN" | tr -d '[:space:]')
MODE=full; [[ "${1:-}" == "--web" ]] && MODE=web; [[ "${1:-}" == "--check" ]] && MODE=check
APP=/srv/fraywick

# ---------------------------------------------------------------- ticker leak guard
[[ -f web/token.json ]] || { echo "✗ web/token.json missing"; exit 1; }
SYMBOL=$(node -e 'const t=JSON.parse(require("fs").readFileSync("web/token.json","utf8")); process.stdout.write(t.symbol == null ? "" : String(t.symbol))')
if [[ -z "$SYMBOL" ]]; then
  if [[ -f .ticker ]]; then
    TICKER=$(tr -d '[:space:]' < .ticker); TICKER=${TICKER#\$}
    [[ -n "$TICKER" ]] || { echo "✗ .ticker is empty — the leak guard cannot run"; exit 1; }
    [[ "$TICKER" =~ ^[A-Za-z0-9]+$ ]] || { echo "✗ .ticker must be letters/digits only (optionally with a leading \$)"; exit 1; }
    SHIPS=(web server cli); for d in contracts/deployments contracts/abi; do if [[ -e $d ]]; then SHIPS+=("$d"); fi; done
    HITS=$(grep -rIilwF --exclude-dir=node_modules --exclude-dir=data --exclude-dir=data-dev --exclude-dir=.git -e "$TICKER" "${SHIPS[@]}" 2>/dev/null || true)
    NAMES=$(find "${SHIPS[@]}" -path '*/node_modules' -prune -o -path 'server/data' -prune -o -path 'server/data-dev' -prune -o -print 2>/dev/null | grep -iwF -e "$TICKER" || true)
    unset TICKER
    if [[ -n "$HITS$NAMES" ]]; then
      echo "✗ TICKER LEAK: the secret ticker appears in these files while token.json symbol is null (value not shown):"
      printf '%s\n%s\n' "$HITS" "$NAMES" | sed '/^$/d; s/^/    /'
      echo "  remove it (say \"the token\"), then deploy again. Nothing was shipped."
      exit 1
    fi
    echo "✓ ticker leak guard: web/ server/ cli/ and contract JSON are clean"
  elif [[ "${NO_TICKER_GUARD:-0}" == "1" ]]; then
    echo "! .ticker missing — leak guard SKIPPED (NO_TICKER_GUARD=1)"
  else
    echo "✗ .ticker missing at the project root while token.json symbol is null — cannot run the leak guard (NO_TICKER_GUARD=1 to skip)"; exit 1
  fi
else
  echo "· token.json symbol is set (launched) — leak guard not needed"
fi

# ---------------------------------------------------------------- checks + offline tests
for f in server/*.mjs server/lib/*.mjs server/sources/*.mjs cli/bin/*.mjs; do [[ -f $f ]] && node --check "$f"; done
node -e 'const t=JSON.parse(require("fs").readFileSync("web/token.json","utf8")); if (!/^0x[0-9a-fA-F]{40}$/.test(t.ca||"")) { console.error("✗ token.json ca is not an address"); process.exit(1) }'
node -e 'for (const f of ["server/sources/skills.json","server/sources/optout.json","cli/config.json"]) JSON.parse(require("fs").readFileSync(f,"utf8"))' || { echo "✗ a sources/config JSON file is invalid"; exit 1; }
for f in jcs.mjs hash.mjs mcp-client.mjs; do cmp -s "server/lib/$f" "cli/lib/$f" || { echo "✗ cli/lib/$f differs from server/lib/$f (cp server/lib/$f cli/lib/)"; exit 1; }; done
[[ -d server/node_modules/viem && -d server/node_modules/@openzeppelin/merkle-tree ]] || (cd server && npm ci --no-audit --no-fund --silent)
[[ -d cli/node_modules/viem ]] || (cd cli && npm install --no-audit --no-fund --silent)
if command -v timeout >/dev/null; then TMO=(timeout 240); elif command -v gtimeout >/dev/null; then TMO=(gtimeout 240); else TMO=(perl -e 'alarm shift; exec @ARGV' 240); fi
(cd server && NO_NETWORK=1 "${TMO[@]}" node --test test/*.test.mjs >/dev/null) || { echo "✗ offline tests fail or hang — not deploying (cd server && npm test)"; exit 1; }
echo "✓ checks + offline tests"
[[ $MODE == check ]] && exit 0

# ---------------------------------------------------------------- web
[[ -f web/index.html ]] || echo "· web/index.html missing (WEB not shipped yet) — syncing what exists (token.json)"
rsync -az --delete --exclude '.DS_Store' --exclude 'dev/' --exclude '_shots/' --exclude 'test/' --exclude '*.test.mjs' --exclude '*.test.js' --exclude '.ticker' web/ "$HOST:$APP/web/"
echo "✓ web synced"
[[ $MODE == web ]] && exit 0

# ---------------------------------------------------------------- server
rsync -az --delete --exclude '/node_modules/' --exclude '/data/' --exclude '/data-dev/' --exclude '/test/' --exclude '/dev-web/' --exclude '.env' --exclude '*.env' --exclude '.ticker' --exclude '.DS_Store' server/ "$HOST:$APP/server/"
for d in deployments abi; do
  if [[ -d contracts/$d ]]; then rsync -az --delete --include '*/' --include '*.json' --exclude '*' "contracts/$d/" "$HOST:$APP/contracts/$d/"; fi
done
ssh "$HOST" "set -e; cd $APP/server && npm ci --omit=dev --no-audit --no-fund --silent && mkdir -p data/snapshots/objects && chown -R fraywick:fraywick data && systemctl restart fraywick-api fraywick-crawler"
echo "✓ server restarted (fraywick-api + fraywick-crawler)"
# Health = our JSON ({"ok":true,"mode":...}), never just HTTP 200.
PORT_REMOTE=$(ssh "$HOST" "sed -n 's/^Environment=PORT=//p' /etc/systemd/system/fraywick-api.service")
for i in $(seq 1 20); do
  LOCAL=$(ssh "$HOST" "curl -fsS http://127.0.0.1:$PORT_REMOTE/api/health" 2>/dev/null || true)
  if [[ $LOCAL == *'"ok":true'* && $LOCAL == *'"mode":"'* ]]; then
    echo "✓ API on VPS port $PORT_REMOTE OK · mode $(node -e 'try{const j=JSON.parse(process.argv[1]);process.stdout.write(j.mode+" · dryPost "+j.dryPost+" · last epoch "+(j.lastEpoch?j.lastEpoch.epoch+" ("+j.lastEpoch.status+")":"none yet"))}catch{}' "$LOCAL")"
    ssh "$HOST" "systemctl is-active --quiet fraywick-crawler" && echo "✓ crawler running (journalctl -u fraywick-crawler -f)" || echo "✗ crawler not running — ssh $HOST journalctl -u fraywick-crawler -n 80"
    if [[ -n "$DOMAIN" ]]; then
      PUB=$(curl -fsS --max-time 10 "https://$DOMAIN/api/health" 2>/dev/null || true)
      if [[ $PUB == *'"ok":true'* && $PUB == *'"mode":"'* ]]; then echo "✓ https://$DOMAIN/api/health OK"
      else echo "· https://$DOMAIN not serving FRAYWICK yet (DNS → VPS, then: ./deploy/provision.sh)"; fi
    fi
    exit 0
  fi
  sleep 2
done
echo "✗ health check failed — ssh $HOST journalctl -u fraywick-api -n 80"; exit 1
