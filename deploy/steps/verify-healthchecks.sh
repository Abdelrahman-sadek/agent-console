#!/usr/bin/env bash
# Step: verify-healthchecks — READ-ONLY. Runs the CURRENT and the PROPOSED health commands
# inside the running containers (no changes, no restarts) and shows where each healthcheck
# is defined, so a fix can be proposed with evidence.
section() { echo; echo "## $1"; echo; echo '```'; }
end() { echo '```'; }
try() { local c="$1"; shift; printf '   %-60s → ' "$*"; out=$(docker exec "$c" "$@" 2>&1 | head -c 120 | tr '\n' ' '); echo "exit=$? ${out}"; }

section "vaultwarden: current vs proposed"
try vaultwarden wget -qO- http://localhost:80/alive
try vaultwarden sh -c 'ls -la /healthcheck.sh 2>&1; command -v curl'
try vaultwarden /healthcheck.sh
echo "   exit code of /healthcheck.sh: $(docker exec vaultwarden /healthcheck.sh >/dev/null 2>&1; echo $?)"
echo "   image's own HEALTHCHECK: $(docker image inspect -f '{{json .Config.Healthcheck}}' vaultwarden/server:latest 2>&1)"
end

for c in meilisearch ims-dev-meilisearch-1; do
section "$c: current vs proposed"
echo "   /etc/hosts localhost lines: $(docker exec "$c" grep -E 'localhost' /etc/hosts | paste -sd';')"
echo "   current  (localhost):  exit=$(docker exec "$c" wget -qO- http://localhost:7700/health >/dev/null 2>&1; echo $?)  $(docker exec "$c" wget -qO- http://localhost:7700/health 2>&1 | head -c 80)"
echo "   proposed (127.0.0.1): exit=$(docker exec "$c" wget -qO- http://127.0.0.1:7700/health >/dev/null 2>&1; echo $?)  $(docker exec "$c" wget -qO- http://127.0.0.1:7700/health 2>&1 | head -c 80)"
end
done

section "Where the healthchecks are defined (compose files)"
for c in vaultwarden meilisearch ims-dev-meilisearch-1; do
  dir=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$c")
  files=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$c")
  echo "$c → $files"
  [ -d "$dir/.git" ] && echo "   git: $(git -C "$dir" remote get-url origin 2>/dev/null | sed -E 's#(https?://)[^@/]+@#\1***@#')  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)  tracked=$(git -C "$dir" ls-files --error-unmatch "${files##*/}" >/dev/null 2>&1 && echo yes || echo no)"
  for f in ${files//,/ }; do grep -nE -A4 'healthcheck:' "$f" 2>/dev/null | sed 's/^/   /'; done
done
end
