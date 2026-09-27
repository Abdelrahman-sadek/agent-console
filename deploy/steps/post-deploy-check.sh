#!/usr/bin/env bash
# Step: post-deploy-check — READ-ONLY. After tayyibt deploy #391 (PR #856):
# is the shared nginx on the persistent setup, and does every site answer as before?
section() { echo; echo "## $1"; echo; echo '```'; }
end() { echo '```'; }
NGX=tayyibt-nginx-1
BASE="$(dirname "$0")/site-baseline.txt"

section "Shared nginx after the deploy"
docker inspect "$NGX" --format 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} created={{.Created}} started={{.State.StartedAt}}' 2>&1
echo "mounts:"; docker inspect "$NGX" --format '{{range .Mounts}}   {{.Source}} → {{.Destination}} (rw={{.RW}}){{"\n"}}{{end}}' 2>&1
nets=$(docker inspect "$NGX" --format '{{range $n,$v := .NetworkSettings.Networks}}{{$n}}{{"\n"}}{{end}}' | sed '/^$/d' | sort)
echo "networks attached: $(echo "$nets" | wc -l) (expected 14)"
missing=$(comm -23 <(sort /opt/edge-nginx/networks.txt) <(echo "$nets")); [ -z "$missing" ] && echo "✅ all networks from networks.txt attached" || echo "❌ missing networks: $missing"
docker exec "$NGX" nginx -t 2>&1 | grep -v deprecated
echo "deployed tayyibt commit: $(git -C /opt/actions-runner/_work/test/test log -1 --format='%h %s' 2>/dev/null | cut -c1-80)"
echo "deployed nginx.conf upstreams: $(grep -oE 'server tayyibt-[a-z-]+-1:[0-9]+' /opt/tayyibt/docker/nginx/nginx.conf | paste -sd' ')"
end

section "Every site vs. before the merge"
same=0; diff=0
while read -r n before; do
  now=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$n:443:127.0.0.1" "https://$n/" || echo 000)
  if [ "$now" = "$before" ]; then same=$((same+1)); else diff=$((diff+1)); echo "   DIFFERENT  $n  before=$before now=$now"; fi
done < "$BASE"
echo "same: $same   different: $diff   (of $(wc -l < "$BASE"))"
end

section "Persistence: files other projects rely on are there"
for p in conf.d/cema.conf conf.d/institutes.conf conf.d/mail.conf certs-mail/fullchain.pem htpasswd/portainer.htpasswd; do
  docker exec "$NGX" test -f "/etc/nginx/$p" && echo "   ✅ $p" || echo "   ❌ $p missing"
done
docker exec "$NGX" test -f /var/www/me/index.html && echo "   ✅ /var/www/me/index.html" || echo "   ❌ me page missing"
end

section "Containers (re)started in the last 30 minutes, and why"
now=$(date +%s)
for c in $(docker ps -a --format '{{.Names}}'); do
  s=$(docker inspect -f '{{.State.StartedAt}}' "$c"); t=$(date -d "$s" +%s 2>/dev/null || echo 0)
  if [ $((now - t)) -lt 1800 ]; then
    printf '   %-26s started %s  restarts=%s  health=%s  project=%s\n' "$c" "${s:11:8}" \
      "$(docker inspect -f '{{.RestartCount}}' "$c")" "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c")" \
      "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c")"
  fi
done
echo; echo "autoheal restarts logged in the last hour:"; docker logs --since 1h tayyibt-autoheal-1 2>&1 | tail -10 | sed 's/^/   /'
echo; echo "docker events (restart/die/start) in the last hour for vaultwarden, meilisearch:"
timeout 5 docker events --since 1h --until 0s --filter container=vaultwarden --filter container=meilisearch \
  --format '   {{.Time}} {{.Actor.Attributes.name}} {{.Action}}' 2>/dev/null | grep -E 'die|start|restart|kill' | tail -10
end

section "Agent Console (should be unaffected)"
docker inspect agent-console --format 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>&1
end

section "Which site answers for names that have no site of their own (default server)?"
for h in localhost 145-14-158-100.sslip.io 145.14.158.100; do
  code=$(curl -sk -o /tmp/pdc.body -w '%{http_code}' --max-time 10 --resolve "$h:443:127.0.0.1" "https://$h/api/v1/health" || echo 000)
  printf '   %-26s /api/v1/health → %s  body: %s\n' "$h" "$code" "$(head -c 120 /tmp/pdc.body | tr '\n' ' ')"
done
rm -f /tmp/pdc.body
echo; echo "first HTTPS server block nginx loads (= default when no default_server is set):"
docker exec "$NGX" nginx -T 2>/dev/null | awk '/^# configuration file/{f=$4} /listen[^;]*443/{print "   " f; exit}'
echo "explicit default_server directives: $(docker exec "$NGX" nginx -T 2>/dev/null | grep -c default_server)"
docker exec "$NGX" nginx -T 2>/dev/null | grep -n default_server | head -5 | sed 's/^/   /'
end
[ "$diff" -eq 0 ]
