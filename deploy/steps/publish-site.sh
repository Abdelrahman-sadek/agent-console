#!/usr/bin/env bash
# Step: publish-site — makes https://agent-console.higher-institute.tech public through the
# shared edge nginx. Changes: one certificate, one site file, one network attachment, one
# graceful `nginx -s reload` (no container restart). Every other site is re-checked after.
# Safe to re-run: skips what is already done.
set -uo pipefail
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
NGX=tayyibt-nginx-1
EDGE=/opt/edge-nginx/etc-nginx
DOMAIN=agent-console.higher-institute.tech
CERT_NAME=agent-console
CERT_DIR="$EDGE/certs-agent-console"
CONF="$EDGE/conf.d/agent-console.conf"
HOOK=/opt/agent-framework/certbot-deploy-hook.sh
BASELINE="$SRC/deploy/steps/site-baseline.txt"
fail() { echo "❌ $*"; echo '```'; exit 1; }

echo "## Publish $DOMAIN"; echo '```'

# 1. Preconditions: nothing is changed unless all of these hold.
[ "$(docker inspect -f '{{.State.Health.Status}}' agent-console 2>/dev/null)" = healthy ] || fail "agent-console is not healthy"
docker exec "$NGX" nginx -t >/dev/null 2>&1 || fail "shared nginx config does not pass nginx -t right now; not touching it"
ip=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1); [ "$ip" = "$(hostname -I | awk '{print $1}')" ] || fail "$DOMAIN resolves to '${ip:-nothing}', not this server"
[ -x /opt/certbot-hooks/dns-auth-hook-hitech.sh ] || fail "DNS auth hook for higher-institute.tech not found"
echo "✅ preconditions: console healthy, nginx config valid, DNS → this server, DNS hooks present"

# 2. Certificate (DNS-01 through the existing Hostinger hooks for higher-institute.tech).
cat > "$HOOK" <<'EOS'
#!/bin/bash
# certbot deploy hook for agent-console: copy the renewed cert into the shared edge, then
# reload nginx only if the full config still validates.
set -euo pipefail
D=/opt/edge-nginx/etc-nginx/certs-agent-console
mkdir -p "$D"
cp -L /etc/letsencrypt/live/agent-console/fullchain.pem "$D/fullchain.pem"
cp -L /etc/letsencrypt/live/agent-console/privkey.pem "$D/privkey.pem"
chmod 600 "$D/privkey.pem"
docker exec tayyibt-nginx-1 nginx -t && docker exec tayyibt-nginx-1 nginx -s reload
EOS
chmod 700 "$HOOK"
if [ -d "/etc/letsencrypt/live/$CERT_NAME" ]; then
  echo "certificate already exists: $(openssl x509 -noout -enddate -in /etc/letsencrypt/live/$CERT_NAME/cert.pem)"
else
  echo "requesting certificate (DNS-01, takes ~1 minute)…"
  certbot certonly --manual --preferred-challenges dns \
    --manual-auth-hook /opt/certbot-hooks/dns-auth-hook-hitech.sh \
    --manual-cleanup-hook /opt/certbot-hooks/dns-cleanup-hook-hitech.sh \
    --deploy-hook "$HOOK" --cert-name "$CERT_NAME" -d "$DOMAIN" \
    --non-interactive --agree-tos --no-eff-email 2>&1 | grep -vE '^\s*$' | tail -8
  [ -d "/etc/letsencrypt/live/$CERT_NAME" ] || fail "certificate was not issued; nothing else was changed"
fi
mkdir -p "$CERT_DIR"
cp -L "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" "$CERT_DIR/fullchain.pem"
cp -L "/etc/letsencrypt/live/$CERT_NAME/privkey.pem" "$CERT_DIR/privkey.pem"; chmod 600 "$CERT_DIR/privkey.pem"
echo "✅ certificate in place ($(openssl x509 -noout -enddate -in "$CERT_DIR/fullchain.pem"))"

# 3. Network: nginx reaches the console over agent-console-net (live attach, no restart).
if docker inspect -f '{{range $n,$v := .NetworkSettings.Networks}}{{$n}} {{end}}' "$NGX" | grep -qw agent-console-net; then
  echo "nginx already on agent-console-net"
else
  docker network connect agent-console-net "$NGX" && echo "✅ nginx attached to agent-console-net (no restart)"
fi
grep -qx agent-console-net /opt/edge-nginx/networks.txt || { echo agent-console-net >> /opt/edge-nginx/networks.txt; echo "✅ recorded in networks.txt (future deploys re-attach it)"; }

# 4. Site file, validated before any reload; removed again if validation fails.
cp "$SRC/deploy/nginx/agent-console.conf" "$CONF"
if docker exec "$NGX" nginx -t 2>&1 | tail -1 | grep -q successful; then
  docker exec "$NGX" nginx -s reload && echo "✅ site file added, nginx -t passed, graceful reload done"
else
  docker exec "$NGX" nginx -t 2>&1 | tail -3
  rm -f "$CONF"; fail "nginx -t failed with the new site file; file removed, nginx NOT reloaded (all sites unchanged)"
fi
sleep 2
echo '```'

# 5. Verify the new site and every existing one.
echo; echo "## Verify"; echo '```'
r() { curl -sk --max-time 10 --resolve "$DOMAIN:$1:127.0.0.1" "$2"; }
echo "http            → $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/")"
echo "https /api/health → $(r 443 "https://$DOMAIN/api/health")"
echo "https page      → $(r 443 "https://$DOMAIN/" | grep -o '<title>[^<]*</title>')"
echo "certificate     → $(echo | openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -subject -issuer 2>/dev/null | tr '\n' ' ')"
echo "public (via DNS) → $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/api/health")"
same=0; diff=0
while read -r n before; do
  now=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$n:443:127.0.0.1" "https://$n/" || echo 000)
  [ "$now" = "$before" ] && same=$((same+1)) || { diff=$((diff+1)); echo "   DIFFERENT $n before=$before now=$now"; }
done < "$BASELINE"
echo "existing sites: same=$same different=$diff (of $(wc -l < "$BASELINE"))"
echo "default (bare IP) → $(curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' --resolve 145.14.158.100:443:127.0.0.1 https://145.14.158.100/)"
echo "tayyibt           → $(curl -sk --resolve 145-14-158-100.sslip.io:443:127.0.0.1 https://145-14-158-100.sslip.io/api/v1/health | head -c 60)"
echo '```'
[ "$diff" -eq 0 ]
