#!/usr/bin/env bash
# Read-only: why does chatting with a builder agent fail on the live site?
# Creates nothing and restarts nothing. Only reads logs, the API, and one event stream.
set -uo pipefail
BASE="${BASE:-/opt/agent-framework}"
PUBLIC="https://agent-console.higher-institute.tech"
pw="$(cat "$BASE/admin-password" 2>/dev/null)"
login() { curl -s -c "$2" -H 'content-type: application/json' --data "$(printf '{"password":"%s"}' "$pw")" "$1/api/login"; }

echo "== container"; docker ps --filter name=agent-console --format '{{.Names}} {{.Status}} {{.Image}}'
echo "== server errors (last 6h)"; docker logs --since 6h agent-console 2>&1 | grep -viE "ExperimentalWarning|trace-warnings" | tail -60

jar="$(mktemp)"; echo "== local login: $(login http://127.0.0.1:3300 "$jar")"
echo "== agents shown in Chat"
curl -s -b "$jar" http://127.0.0.1:3300/api/agents | python3 -c '
import json,sys
for a in json.load(sys.stdin): print("  %-14s %-8s v%-4s %-30s %s" % (a["id"], a.get("kind","?"), a.get("version"), a["name"][:30], a.get("model","")))'
echo "== builder agents (incl. drafts)"
curl -s -b "$jar" http://127.0.0.1:3300/api/builder/agents | python3 -c '
import json,sys
for a in json.load(sys.stdin): print("  %-14s live=%-5s changes=%-5s %-30s %s" % (a["id"], a["currentVersion"], a["unpublishedChanges"], a["name"][:30], a["model"]))'
echo "== recent runs"
curl -s -b "$jar" http://127.0.0.1:3300/api/runs > "$jar.runs"
python3 - "$jar.runs" <<'PY'
import json, sys
runs = json.load(open(sys.argv[1]))
for r in runs[:12]:
    err = (r.get("error") or {}).get("message", "")
    print("  %s %-20s %-22s %s" % (r["createdAt"][:19], r["agentId"][:20], r["status"], err[:160]))
PY
latest="$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r[0]["runId"] if r else "")' "$jar.runs")"
rm -f "$jar" "$jar.runs"

pjar="$(mktemp)"; echo "== public login: $(login "$PUBLIC" "$pjar")"
echo "== public pages"
for p in / /api/health /api/agents /api/builder/models; do printf '  %-22s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code} %{size_download}B %{time_total}s' -b "$pjar" "$PUBLIC$p")"; done
asset="$(curl -s "$PUBLIC/" | grep -oE '/assets/index-[^"]+\.js' | head -1)"
printf '  %-22s %s\n' "$asset" "$(curl -s -o /dev/null -w '%{http_code} %{size_download}B' "$PUBLIC$asset")"
if [ -n "$latest" ]; then
  echo "== live stream of the latest run through nginx (5 s)"
  curl -s -N --max-time 5 -b "$pjar" -D - "$PUBLIC/api/runs/$latest/stream" | head -c 1500 | sed -E 's/"(input|output|content|text)":"[^"]{40,}/"\1":"…/g'; echo
fi
rm -f "$pjar"
echo "== nginx errors for the console (last 30)"
docker exec tayyibt-nginx-1 sh -c 'tail -n 400 /var/log/nginx/error.log 2>/dev/null' 2>/dev/null | grep -i "agent-console" | tail -30
echo "== nginx site config"; docker exec tayyibt-nginx-1 sh -c 'cat /etc/nginx/conf.d/agent-console.conf' 2>/dev/null | grep -vE '^\s*#' | grep -vE '^\s*$' | head -60

echo; echo "== SELF-TEST through the public site (creates a temporary agent, then deletes it)"
J="$(mktemp)"; login "$PUBLIC" "$J" >/dev/null
api() { curl -s -b "$J" -H 'content-type: application/json' "$@"; }
ID="$(api -X POST "$PUBLIC/api/builder/agents" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')"
echo "  create agent:        ${ID:-FAILED}"
if [ -n "$ID" ]; then
  api -X PUT "$PUBLIC/api/builder/agents/$ID" -d '{"spec":{"name":"VPS self-test","instructions":"Say hello briefly. This is an automatic test.","model":{"providerId":"demo","modelId":"demo"}}}' -o /dev/null -w "  save draft:          %{http_code}\n"
  DRAFT_RUN="$(api -X POST "$PUBLIC/api/agents/$ID/runs" -d '{"input":"test chat hello","draft":true}')"; echo "  test-chat run:       $DRAFT_RUN"
  api -X POST "$PUBLIC/api/builder/agents/$ID/publish" -d '{"note":"self-test"}' -o /dev/null -w "  publish:             %{http_code}\n"
  printf '  listed in Chat:      '; api "$PUBLIC/api/agents" | python3 -c "import json,sys; print(any(a['id']=='$ID' for a in json.load(sys.stdin)))"
  RUN="$(api -X POST "$PUBLIC/api/agents/$ID/runs" -d '{"input":"hello from the VPS self-test"}' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("runId",""))')"
  echo "  chat run started:    ${RUN:-FAILED}"
  if [ -n "$RUN" ]; then
    echo "  live stream (nginx), first 8 s:"
    curl -s -N --max-time 8 -b "$J" "$PUBLIC/api/runs/$RUN/stream" | grep -E '^event:' | sort | uniq -c | sed 's/^/    /'
    printf '  final run state:     '; api "$PUBLIC/api/runs/$RUN" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r.get("status"), "|", str(r.get("output"))[:120], "|", r.get("error"))'
  fi
  api -X DELETE "$PUBLIC/api/builder/agents/$ID" -o /dev/null -w "  delete test agent:   %{http_code}\n"
fi
rm -f "$J"

echo; echo "== console log file (last 60 entries)"
tail -n 60 "$BASE/data/logs/console.log" 2>/dev/null || echo "  (no log file yet)"
