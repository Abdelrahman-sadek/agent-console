#!/usr/bin/env bash
# Read-only: show the console's issue log and recent run errors.
set -uo pipefail
BASE="${BASE:-/opt/agent-framework}"
FILE="$BASE/data/logs/console.log"
echo "== issue log: $FILE"
if [ -f "$FILE" ]; then
  echo "  entries: $(wc -l < "$FILE")  (errors: $(grep -c '"level":"error"' "$FILE"), warnings: $(grep -c '"level":"warn"' "$FILE"))"
  grep -v '"source":"startup"' "$FILE" | tail -n 40 | python3 -c '
import json, sys
for line in sys.stdin:
    try: i = json.loads(line)
    except Exception: print("  " + line.rstrip()); continue
    d = i.get("detail") or {}
    extra = {k: v for k, v in d.items() if k not in ("stack",)}
    print("  %s %-5s %-8s %s" % (i["time"][:19], i["level"], i["source"], i["message"]))
    if extra: print("      " + json.dumps(extra)[:400])
    if "stack" in d:
        for n, l in enumerate(str(d["stack"]).splitlines()[:40]): print("      | " + l[:300])
'
else
  echo "  (no log file yet)"
fi
jar="$(mktemp)"; pw="$(cat "$BASE/admin-password" 2>/dev/null)"
curl -s -c "$jar" -H 'content-type: application/json' --data "$(printf '{"password":"%s"}' "$pw")" http://127.0.0.1:3300/api/login >/dev/null
echo; echo "== recent runs"
curl -s -b "$jar" http://127.0.0.1:3300/api/runs > "$jar.r"
python3 - "$jar.r" <<'PY'
import json, sys
for r in json.load(open(sys.argv[1]))[:15]:
    err = ((r.get("error") or {}).get("message") or "").replace("\n", " ")
    print("  %s %-20s %-22s %s" % (r["createdAt"][:19], r["agentId"][:20], r["status"], err[:220]))
PY
echo; echo "== agents in Chat"
curl -s -b "$jar" http://127.0.0.1:3300/api/agents | python3 -c '
import json,sys
for a in json.load(sys.stdin): print("  %-14s %-30s %s" % (a["id"], a["name"][:30], a.get("model","")))'
rm -f "$jar" "$jar.r"
echo; echo "== container errors (last 2h)"; docker logs --since 2h agent-console 2>&1 | grep -iE "error|warn|fail" | grep -v ExperimentalWarning | tail -30 || true  # nothing found is not a failure
