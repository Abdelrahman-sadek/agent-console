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

section "Agent Console (should be unaffected)"
docker inspect agent-console --format 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>&1
end
[ "$diff" -eq 0 ]
