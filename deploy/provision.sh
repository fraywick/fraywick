#!/usr/bin/env bash
# One-time VPS setup for FRAYWICK (idempotent; re-run to apply a changed nginx.conf / headers / units — the port is remembered from
# the running API unit): system user + dirs, /etc/fraywick/*.env placeholders (root-only for keys), certbot (webroot), two systemd
# units (fraywick-api, fraywick-crawler), nginx site.
#   ./deploy/provision.sh                 first run: port 4891 (default) — refused if `ss -ltnp` shows it taken
#   PORT=4895 ./deploy/provision.sh       another port (also checked)
#   SKIP_CERT=1 ./deploy/provision.sh     DNS not pointed yet: units only, no nginx/cert
# Env: HOST (ssh alias; default .deploy-host, else us1) · DOMAIN (default .deploy-domain; required unless SKIP_CERT=1) · PORT (4891)
#      CERTBOT_EMAIL (optional) · SKIP_CERT=1.
# Keys are NEVER copied by this script: the lead fills /etc/fraywick/poster.env (and optionally github.env) by hand on the VPS.
# The lead runs this; agents never deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${HOST:-$(cat .deploy-host 2>/dev/null || echo us1)}
HOST=$(echo "$HOST" | tr -d '[:space:]')
DOMAIN=${DOMAIN:-$(cat .deploy-domain 2>/dev/null || true)}
DOMAIN=$(echo "$DOMAIN" | tr -d '[:space:]')
PORT=${PORT:-4891}
if [[ "${SKIP_CERT:-0}" != "1" ]]; then [[ $DOMAIN =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "✗ DOMAIN missing or bad ('$DOMAIN'): write it to .deploy-domain or pass DOMAIN=…"; exit 1; }; fi
[[ $PORT =~ ^[0-9]{4,5}$ ]] || { echo "✗ bad PORT: $PORT"; exit 1; }

scp -q deploy/fraywick-api.service "$HOST:/tmp/fraywick-api.service.tpl"
scp -q deploy/fraywick-crawler.service "$HOST:/tmp/fraywick-crawler.service.tpl"
scp -q deploy/nginx.conf "$HOST:/tmp/fraywick.nginx.tpl"
scp -q deploy/fraywick-proxy.conf "$HOST:/etc/nginx/fraywick-proxy.conf"
scp -q deploy/fraywick-headers.conf "$HOST:/etc/nginx/fraywick-headers.conf"

ssh "$HOST" PORT="$PORT" DOMAIN="$DOMAIN" CERTBOT_EMAIL="${CERTBOT_EMAIL:-}" SKIP_CERT="${SKIP_CERT:-0}" bash -s <<'REMOTE'
set -euo pipefail
command -v node >/dev/null || { echo "✗ node missing on the VPS"; exit 1; }
node -e 'require("node:sqlite")' 2>/dev/null || { echo "✗ this node has no node:sqlite (need ≥ 22.13): $(node -v)"; exit 1; }
command -v npm >/dev/null || { echo "✗ npm missing"; exit 1; }
command -v nginx >/dev/null || { echo "✗ nginx missing"; exit 1; }

mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
grep -rqs 'sites-enabled' /etc/nginx/nginx.conf || echo "! /etc/nginx/nginx.conf does not include sites-enabled/* — add 'include /etc/nginx/sites-enabled/*;' to the http block"
id fraywick >/dev/null 2>&1 || useradd --system --home /srv/fraywick --shell /usr/sbin/nologin fraywick
mkdir -p /srv/fraywick/web /srv/fraywick/server/data/snapshots/objects /srv/fraywick/contracts/deployments /srv/fraywick/contracts/abi /var/www/html/.well-known/acme-challenge
chown -R fraywick:fraywick /srv/fraywick/server/data
chmod 755 /srv/fraywick /srv/fraywick/server /srv/fraywick/server/data /srv/fraywick/server/data/snapshots /srv/fraywick/server/data/snapshots/objects   # nginx reads objects/

# ---- /etc/fraywick: keys root-only (systemd reads them as root), settings readable by the service group ----
install -d -m 755 -o root -g root /etc/fraywick
mk() {  # file, mode, owner, content
  if [ ! -f "$1" ]; then ( umask 077; printf '%s\n' "$4" > "$1" ); fi
  chmod "$2" "$1"; chown "$3" "$1"
}
mk /etc/fraywick/poster.env 600 root:root '# POSTER_PRIVATE_KEY=0x…  (ToolAnchor poster 0x3D0d1B5dfe2f5004640A42595EbCff5fE3dE59eC). Filled by hand, never by deploy.sh.'
mk /etc/fraywick/github.env 600 root:root '# GITHUB_TOKEN=…  (optional; fine-grained token with public read-only access — skills crawl)'
if [ -n "$DOMAIN" ]; then PUB="PUBLIC_URL=https://$DOMAIN"; else PUB="# PUBLIC_URL=https://<domain>   (required before DRY_POST=0)"; fi
mk /etc/fraywick/fraywick.env 640 root:fraywick "# FRAYWICK settings (no secrets here)
$PUB
# DRY_POST=0        # go live: the crawler posts roots + flags with the poster key
# ANCHOR_ADDRESS=0x… # only if contracts/deployments/robinhood.json is not shipped
# RPC_URL=https://robinhood-rpc.publicnode.com
# CONCURRENCY=16
# CHECK_HTTP_ALLOW=   # comma-separated hosts /api/check may fetch over plain http (default none)"
grep -q '^POSTER_PRIVATE_KEY=0x' /etc/fraywick/poster.env && echo "✓ poster key present" || echo "· poster key not set yet (crawler stays dry until it is AND DRY_POST=0)"
grep -q '^GITHUB_TOKEN=.' /etc/fraywick/github.env && echo "✓ GitHub token present" || echo "· no GitHub token (skills crawl uses the 60/h anonymous limit)"
grep -q '^DRY_POST=0' /etc/fraywick/fraywick.env && echo "! DRY_POST=0: the crawler WILL post" || echo "· DRY_POST on (default)"

# ---- port: ours if the API unit already runs on it, else $PORT must be free ----
taken() { ss -ltnH "( sport = :$1 )" | grep -q .; }
CUR=$(sed -n 's/^Environment=PORT=//p' /etc/systemd/system/fraywick-api.service 2>/dev/null || true)
if [ -n "$CUR" ] && [ "$CUR" != "PORT_PLACEHOLDER" ] && systemctl is-active --quiet fraywick-api; then
  [ "$PORT" != "$CUR" ] && echo "· fraywick-api already runs on $CUR — keeping it (stop it first to move ports)"
  PORT=$CUR
elif taken "$PORT"; then
  echo "✗ port $PORT is taken on the VPS (ss -ltnp below) — pick another: PORT=… ./deploy/provision.sh"; ss -ltnp | head -50; exit 1
fi
echo "→ port $PORT (free on ss -ltnp) · domain ${DOMAIN:-none yet}"

install_units() {
  sed "s/PORT_PLACEHOLDER/$PORT/g" /tmp/fraywick-api.service.tpl > /etc/systemd/system/fraywick-api.service
  cp -f /tmp/fraywick-crawler.service.tpl /etc/systemd/system/fraywick-crawler.service
  systemctl daemon-reload
  systemctl enable fraywick-api fraywick-crawler >/dev/null 2>&1 || true
}

if [ "$SKIP_CERT" = "1" ] && { [ -z "$DOMAIN" ] || [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; }; then
  install_units
  rm -f /tmp/fraywick-*.service.tpl /tmp/fraywick.nginx.tpl
  echo "✓ units installed (API on 127.0.0.1:$PORT; no nginx/cert yet: point DNS A records for the domain + www here, then re-run without SKIP_CERT)"
  exit 0
fi

if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  command -v certbot >/dev/null || { echo "✗ certbot missing (apt install certbot)"; exit 1; }
  cat > /etc/nginx/sites-available/fraywick <<EOF2
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
EOF2
  ln -sf /etc/nginx/sites-available/fraywick /etc/nginx/sites-enabled/fraywick
  nginx -t && systemctl reload nginx
  if [ -n "$CERTBOT_EMAIL" ]; then EMAIL=(-m "$CERTBOT_EMAIL"); else EMAIL=(--register-unsafely-without-email); fi
  certbot certonly --webroot -w /var/www/html -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos "${EMAIL[@]}"
  echo "✓ certificate for $DOMAIN + www"
fi

install_units
grep -q '^PUBLIC_URL=' /etc/fraywick/fraywick.env || sed -i "s|^# PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" /etc/fraywick/fraywick.env

SITE=/etc/nginx/sites-available/fraywick
[ -f "$SITE" ] && cp -f "$SITE" "$SITE.bak"
sed -e "s/PORT_PLACEHOLDER/$PORT/g" -e "s/fraywick\.xyz/$DOMAIN/g" /tmp/fraywick.nginx.tpl > "$SITE"
ln -sf "$SITE" /etc/nginx/sites-enabled/fraywick
if nginx -t; then systemctl reload nginx; echo "✓ nginx reloaded with the fraywick site"
else
  echo "✗ nginx -t failed — restoring the previous site"; [ -f "$SITE.bak" ] && mv -f "$SITE.bak" "$SITE"; nginx -t && systemctl reload nginx; exit 1
fi
rm -f /tmp/fraywick-*.service.tpl /tmp/fraywick.nginx.tpl
REMOTE
echo "→ provisioned. Next: fill /etc/fraywick/poster.env on the VPS by hand, then ./deploy.sh (crawler stays DRY until DRY_POST=0 in fraywick.env)"
