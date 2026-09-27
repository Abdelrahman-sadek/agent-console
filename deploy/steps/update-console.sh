#!/usr/bin/env bash
# Rebuild the console image and recreate ONLY the agent-console container (a few seconds of
# downtime for this one site; no other container, network or nginx is touched).
# Then report which model providers are configured — never the keys themselves.
set -uo pipefail
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${BASE:-/opt/agent-framework}"
COMPOSE=(docker compose -p agent-console -f "$SRC/deploy/docker-compose.yml")

umask 022
git -C "$SRC" submodule update --init --depth 1 vendor/agents-framework 2>&1 | tail -2
chmod -R a+rX "$SRC"
echo "== keys present (names only)"; cut -d= -f1 "$BASE/app.env" | paste -sd' '
echo "== build"; "${COMPOSE[@]}" build agent-console 2>&1 | tail -5
echo "== recreate agent-console only"; "${COMPOSE[@]}" up -d --no-deps --force-recreate agent-console 2>&1 | tail -3
for i in $(seq 1 45); do s=$(docker inspect -f '{{.State.Health.Status}}' agent-console 2>/dev/null); [ "$s" = healthy ] && break; sleep 2; done
echo "container health: ${s:-unknown}"
echo "health endpoint: $(curl -s --max-time 5 http://127.0.0.1:3300/api/health)"

echo "== model providers"
jar="$(mktemp)"; pw="$(cat "$BASE/admin-password" 2>/dev/null)"
curl -s -c "$jar" -H 'content-type: application/json' --data "$(printf '{"password":"%s"}' "$pw")" http://127.0.0.1:3300/api/login >/dev/null
curl -s -b "$jar" http://127.0.0.1:3300/api/builder/models | python3 -c 'import json,sys; [print(f"  {p[\"id\"]:<11} {\"configured\" if p[\"configured\"] else \"not configured\"}") for p in json.load(sys.stdin)]' 2>/dev/null || echo "  (could not read providers)"
echo "== builder API"; curl -s -o /dev/null -w "  /api/builder/catalog -> %{http_code}\n" -b "$jar" http://127.0.0.1:3300/api/builder/catalog
rm -f "$jar"
echo "== public"; curl -s -o /dev/null -w "  https://agent-console.higher-institute.tech -> %{http_code}\n" --max-time 10 https://agent-console.higher-institute.tech/
echo "== recent logs"; docker logs --tail 15 agent-console 2>&1
[ "${s:-}" = healthy ]
