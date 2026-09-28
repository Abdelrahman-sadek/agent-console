#!/usr/bin/env bash
# Rebuild and recreate ONLY the agent-console and skillware-runner containers (a few seconds of
# downtime for this one site; no other container, network or nginx is touched).
# Then report which model providers are configured — never the keys themselves.
set -uo pipefail
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${BASE:-/opt/agent-framework}"
COMPOSE=(docker compose -p agent-console -f "$SRC/deploy/docker-compose.yml")

umask 022
git -C "$SRC" submodule update --init --depth 1 vendor/agents-framework vendor/skillware 2>&1 | tail -2
# Shared secret between the console and the Skillware runner (created once, root-only file).
if ! grep -q '^SKILLWARE_TOKEN=' "$BASE/app.env"; then
  (umask 077; printf 'SKILLWARE_TOKEN=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)" >> "$BASE/app.env")
  echo "created SKILLWARE_TOKEN"
fi
chmod -R a+rX "$SRC"
echo "== keys present (names only)"; cut -d= -f1 "$BASE/app.env" | paste -sd' '
echo "== build"; "${COMPOSE[@]}" build agent-console skillware-runner 2>&1 | tail -8
echo "== start skillware-runner"; "${COMPOSE[@]}" up -d --no-deps skillware-runner 2>&1 | tail -3
for i in $(seq 1 60); do r=$(docker inspect -f '{{.State.Health.Status}}' skillware-runner 2>/dev/null); [ "$r" = healthy ] && break; sleep 2; done
echo "skillware-runner health: ${r:-unknown}"
echo "== recreate agent-console only"; "${COMPOSE[@]}" up -d --no-deps --force-recreate agent-console 2>&1 | tail -3
for i in $(seq 1 45); do s=$(docker inspect -f '{{.State.Health.Status}}' agent-console 2>/dev/null); [ "$s" = healthy ] && break; sleep 2; done
echo "container health: ${s:-unknown}"
echo "health endpoint: $(curl -s --max-time 5 http://127.0.0.1:3300/api/health)"

echo "== model providers"
jar="$(mktemp)"; pw="$(cat "$BASE/admin-password" 2>/dev/null)"
curl -s -c "$jar" -H 'content-type: application/json' --data "$(printf '{"password":"%s"}' "$pw")" http://127.0.0.1:3300/api/login >/dev/null
curl -s -b "$jar" http://127.0.0.1:3300/api/builder/models > "$jar.models"
python3 - "$jar.models" <<'PY' || echo "  (could not read providers)"
import json, sys
for p in json.load(open(sys.argv[1])):
    print("  %-11s %s" % (p["id"], "configured" if p["configured"] else "not configured"))
PY
rm -f "$jar.models"
echo "== skillware"; curl -s -b "$jar" http://127.0.0.1:3300/api/builder/skillware | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  available:", d["available"], d.get("error",""), "| skills:", len(d["skills"]))' 2>/dev/null || echo "  (could not read)"
docker logs --tail 3 skillware-runner 2>&1 | sed 's/^/  runner: /'
echo "== builder API"; curl -s -o /dev/null -w "  /api/builder/catalog -> %{http_code}\n" -b "$jar" http://127.0.0.1:3300/api/builder/catalog
rm -f "$jar"
echo "== public"; curl -s -o /dev/null -w "  https://agent-console.higher-institute.tech -> %{http_code}\n" --max-time 10 https://agent-console.higher-institute.tech/
echo "== recent logs"; docker logs --tail 15 agent-console 2>&1
[ "${s:-}" = healthy ]
