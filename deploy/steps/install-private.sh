#!/usr/bin/env bash
# Step: install-private — installs Agent Console as its OWN container, reachable only
# on this server at 127.0.0.1:3300. Does not touch the shared nginx, other containers,
# other networks or the system Node. Re-running it updates the console.
set -uo pipefail
BASE=/opt/agent-framework
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE=(docker compose -p agent-console -f "$SRC/deploy/docker-compose.yml")

snapshot() { docker ps --format '{{.Names}} {{.State}}' | grep -v '^agent-console ' | sort; }
echo "## Install Agent Console (private)"; echo '```'

# Guards: port 3300 must be free or already ours.
owner=$(docker ps --filter publish=3300 --format '{{.Names}}')
if ss -ltnH | awk '{print $4}' | grep -qE ':3300$' && [ "$owner" != "agent-console" ]; then
  echo "❌ port 3300 is used by something else (${owner:-a non-Docker process}). Nothing was changed."; exit 1
fi
BEFORE="$(snapshot)"; NGX_START="$(docker inspect -f '{{.State.StartedAt}}' tayyibt-nginx-1 2>/dev/null)"

mkdir -p "$BASE/data" && chown 1000:1000 "$BASE/data"
if [ ! -s "$BASE/app.env" ]; then
  PW="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  umask 077; printf 'ADMIN_PASSWORD=%s\n' "$PW" > "$BASE/app.env"; printf '%s\n' "$PW" > "$BASE/admin-password"
  echo "Created admin password (stored in $BASE/admin-password, readable by root only)."
fi
chmod 600 "$BASE/app.env" "$BASE/admin-password" 2>/dev/null

echo "Fetching the framework (git submodule)…"
umask 022
git -C "$SRC" submodule update --init --depth 1 vendor/agents-framework 2>&1 | tail -2
# This server's default umask is 077, which made the checkout root-only; the container
# runs as the unprivileged `node` user and must be able to read it. Only our own folder.
chmod -R a+rX "$SRC"
echo "source readable by the container user: $(stat -c %A "$SRC/vendor/agents-framework/packages/core")"
echo "Building the image (first time takes a few minutes)…"
"${COMPOSE[@]}" build 2>&1 | grep -E 'ERROR|error|Built|built in|naming to' | tail -8
"${COMPOSE[@]}" up -d 2>&1 | tail -3

for i in $(seq 1 45); do s=$(docker inspect -f '{{.State.Health.Status}}' agent-console 2>/dev/null); [ "$s" = healthy ] && break; sleep 2; done
echo "container health: ${s:-unknown}"
echo "health endpoint: $(curl -s --max-time 5 http://127.0.0.1:3300/api/health)"
echo "listening on: $(docker port agent-console 2>/dev/null | paste -sd' ')"
echo "memory: $(docker stats --no-stream --format '{{.MemUsage}}' agent-console 2>/dev/null)"
echo '```'

echo; echo "## Nothing else changed?"; echo '```'
AFTER="$(snapshot)"
if [ "$BEFORE" = "$AFTER" ]; then echo "✅ all other containers: same names and states as before ($(echo "$AFTER" | wc -l))"; else echo "⚠️ other containers changed:"; diff <(echo "$BEFORE") <(echo "$AFTER"); fi
[ "$NGX_START" = "$(docker inspect -f '{{.State.StartedAt}}' tayyibt-nginx-1 2>/dev/null)" ] && echo "✅ shared nginx not restarted" || echo "⚠️ shared nginx restarted"
echo "agent-console networks: $(docker inspect -f '{{range $n,$v := .NetworkSettings.Networks}}{{$n}} {{end}}' agent-console)"
echo '```'
[ "${s:-}" = healthy ]
