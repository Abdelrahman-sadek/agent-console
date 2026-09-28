#!/usr/bin/env bash
# Step: read-nginx — READ-ONLY for everything live.
# 1) the ACTUAL deployed tayyibt nginx.conf, 2) the full live config of every site,
# 3) a dry run of the proposed agent-console block in a THROWAWAY container
#    (same method tayyibt's cd-deploy.sh uses). The live nginx is not touched.

section() { echo; echo "## $1"; echo; echo '```'; }
end() { echo '```'; }
NGX="tayyibt-nginx-1"
LIVE=/opt/tayyibt/docker/nginx/nginx.conf
SRC="$(cd "$(dirname "$0")/../.." && pwd)"

section "1. Deployed file $LIVE (checksum, date, full content)"
sha256sum "$LIVE"; stat -c 'modified: %y  size: %s bytes' "$LIVE"
RUNNER_CHECKOUT=/opt/actions-runner/_work/test/test
if [ -d "$RUNNER_CHECKOUT/.git" ]; then
  echo "last deployed commit (runner checkout): $(git -C "$RUNNER_CHECKOUT" log -1 --format='%h %cs %s' 2>/dev/null)"
  echo "runner checkout file checksum: $(sha256sum "$RUNNER_CHECKOUT/docker/nginx/nginx.conf" 2>/dev/null | cut -c1-64)"
fi
echo "file inside running container matches: $(docker exec "$NGX" sha256sum /etc/nginx/conf.d/default.conf 2>/dev/null | cut -c1-64)"
echo; cat -n "$LIVE"
end

section "2. Full live nginx config of every site (nginx -T)"
docker exec "$NGX" nginx -T 2>/dev/null
end

section "3. Dry run: deployed nginx.conf + proposed agent-console block, in a throwaway container"
TMP="$(mktemp -d)"
cp "$LIVE" "$TMP/default.conf"
printf '\n' >> "$TMP/default.conf"
cat "$SRC/deploy/proposed/tayyibt-nginx-agent-console-block.conf" >> "$TMP/default.conf"
mkdir -p "$TMP/test-cert"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=agent-console.higher-institute.tech" \
  -keyout "$TMP/test-cert/privkey.pem" -out "$TMP/test-cert/fullchain.pem" >/dev/null 2>&1 && echo "temporary test certificate created (deleted after this test)"
NET="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' tayyibt-backend-1 2>/dev/null | awk '{print $1}')"
echo "network used for the test (same as cd-deploy.sh): ${NET:-tayyibt_tayyibt-network}"
docker run --rm --network "${NET:-tayyibt_tayyibt-network}" \
  -v "$TMP/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v /opt/tayyibt/certs:/etc/nginx/certs:ro \
  -v "$TMP/test-cert:/etc/nginx/certs/agent-console:ro" \
  nginx:1.25-alpine nginx -t 2>&1
echo "dry-run exit code: $?"
echo; echo "Same test WITHOUT the proposed block (baseline):"
docker run --rm --network "${NET:-tayyibt_tayyibt-network}" \
  -v "$LIVE:/etc/nginx/conf.d/default.conf:ro" -v /opt/tayyibt/certs:/etc/nginx/certs:ro \
  nginx:1.25-alpine nginx -t 2>&1
echo "baseline exit code: $?"
rm -rf "$TMP"; echo "temporary files removed"
echo; echo "/opt/tayyibt/certs contents (names only):"; ls -la /opt/tayyibt/certs
end
