#!/usr/bin/env bash
# Step: diagnose-health — READ-ONLY. Why does autoheal keep restarting these containers?
C="vaultwarden meilisearch ims-dev-meilisearch-1"
section() { echo; echo "## $1"; echo; echo '```'; }
end() { echo '```'; }
for c in $C; do
  section "$c"
  docker inspect "$c" --format 'image={{.Config.Image}}  image id={{.Image}}
status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}} failing streak={{.State.Health.FailingStreak}}{{end}} started={{.State.StartedAt}}
healthcheck={{json .Config.Healthcheck}}' 2>&1 | cut -c1-300
  echo "image created: $(docker image inspect -f '{{.Created}}' "$(docker inspect -f '{{.Image}}' "$c")" 2>/dev/null)"
  echo; echo "last health check results:"
  docker inspect "$c" --format '{{range .State.Health.Log}}  exit={{.ExitCode}} {{.Start}} {{printf "%.150s" .Output}}{{"\n"}}{{end}}' 2>&1 | tail -4
  echo; echo "is the health command available inside? $(docker exec "$c" sh -c 'command -v wget curl 2>/dev/null | paste -sd" "' 2>&1 | head -1)"
  echo; echo "first / last autoheal restart of $c (all history):"
  docker logs tayyibt-autoheal-1 2>&1 | grep -F "/$c " | sed -n '1p;$p' | sed 's/^/  /'
  echo "total autoheal restarts: $(docker logs tayyibt-autoheal-1 2>&1 | grep -cF "/$c ")"
  echo; echo "last 8 log lines of $c:"; docker logs --tail 8 "$c" 2>&1 | cut -c1-200 | sed 's/^/  /'
  end
done
section "autoheal setup"
docker inspect tayyibt-autoheal-1 --format 'env={{range .Config.Env}}{{if or (eq (index (split . "=") 0) "AUTOHEAL_CONTAINER_LABEL") (eq (index (split . "=") 0) "AUTOHEAL_INTERVAL") (eq (index (split . "=") 0) "AUTOHEAL_START_PERIOD")}}{{.}} {{end}}{{end}} started={{.State.StartedAt}}' 2>&1
echo "autoheal log first line: $(docker logs tayyibt-autoheal-1 2>&1 | head -1 | cut -c1-160)"
end
