#!/usr/bin/env bash
# Step: check-edge — READ-ONLY. Verifies the maintainer's runbook stages 1 and 2.

section() { echo; echo "## $1"; echo; echo '```'; }
end() { echo '```'; }
NGX="tayyibt-nginx-1"; EDGE="/opt/edge-nginx"

section "Stage 1: export and backup"
ls -la "$EDGE" 2>&1
echo; echo "conf.d files exported: $(ls "$EDGE/etc-nginx/conf.d" 2>/dev/null | wc -l)"; ls "$EDGE/etc-nginx/conf.d" 2>/dev/null | sed 's/^/   /'
echo; echo "cert/extra folders exported:"; ls -d "$EDGE"/etc-nginx/*/ 2>/dev/null | sed 's/^/   /'
echo; echo "networks.txt ($(wc -l < "$EDGE/networks.txt" 2>/dev/null || echo 0) lines):"; sed 's/^/   /' "$EDGE/networks.txt" 2>/dev/null
echo; echo "backups:"; ls -la "$EDGE/backups" 2>/dev/null | tail -n +2
for b in "$EDGE"/backups/*.tar.gz; do [ -f "$b" ] && echo "   $(basename "$b"): $(tar -tzf "$b" 2>/dev/null | wc -l) entries, archive $(gzip -t "$b" 2>/dev/null && echo OK || echo CORRUPT)"; done
end

section "Export matches the live container right now?"
live=$(docker exec "$NGX" sh -c 'cd /etc/nginx && find . -type f ! -path "./conf.d/default.conf" ! -path "./certs/*" -exec sha256sum {} \; | sort -k2' 2>/dev/null)
saved=$(cd "$EDGE/etc-nginx" 2>/dev/null && find . -type f ! -path "./conf.d/default.conf" ! -path "./certs/*" -exec sha256sum {} \; | sort -k2)
echo "files in live container: $(echo "$live" | grep -c .)   files in export: $(echo "$saved" | grep -c .)"
d=$(diff <(echo "$live") <(echo "$saved"))
if [ -z "$d" ]; then echo "✅ identical"; else echo "differences (< live, > export):"; echo "$d" | awk '{print $1, $3}' | head -30; fi
end

section "Stage 2: rehearsal container removed?"
docker ps -a --format '{{.Names}} {{.Status}}' | grep -E 'edge-test|edge-rehearsal' || echo "✅ no rehearsal container left"
ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E ':18443$|:18080$' || echo "✅ ports 18080/18443 free"
end

section "Live nginx untouched and healthy?"
docker inspect "$NGX" --format 'created: {{.Created}}  started: {{.State.StartedAt}}  status: {{.State.Status}}  health: {{if .State.Health}}{{.State.Health.Status}}{{end}}'
docker exec "$NGX" nginx -t 2>&1 | grep -v deprecated
echo; echo "sites (live 443):"
for n in $(docker exec "$NGX" nginx -T 2>/dev/null | grep -E '^\s*server_name' | sed -E 's/^\s*server_name\s+//; s/;.*//' | tr ' ' '\n' | grep -vE '^(_|)$' | sort -u); do
  printf '   %-42s %s\n' "$n" "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$n:443:127.0.0.1" "https://$n/" || echo 000)"
done
end

section "tayyibt repo state on the server"
echo "runner checkout: $(git -C /opt/actions-runner/_work/test/test log -1 --format='%h %cs %s' 2>/dev/null)"
echo "deployed nginx.conf: $(sha256sum /opt/tayyibt/docker/nginx/nginx.conf | cut -c1-16)"
end
