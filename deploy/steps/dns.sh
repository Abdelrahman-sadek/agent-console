#!/usr/bin/env bash
# Step: dns — adds ONE record: A agent-console.higher-institute.tech → this server.
# Uses the Hostinger API with a token stored only on this server (root-only file).
# Never overwrites: stops if a record with that name already exists.
set -uo pipefail

DOMAIN="higher-institute.tech"
NAME="agent-console"
FQDN="$NAME.$DOMAIN"
TOKEN_FILE="/opt/agent-framework/hostinger-token"
API="https://developers.hostinger.com/api/dns/v1/zones/$DOMAIN"
LOCAL_IP="$(hostname -I | awk '{print $1}')"
PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
IP="$LOCAL_IP"

echo "## DNS: $FQDN → $IP"
echo '```'
echo "Server address: $LOCAL_IP   Seen from the internet: ${PUBLIC_IP:-unknown}"
if [ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "$LOCAL_IP" ]; then
  echo "⏸  These differ, so the right address is unclear. Nothing was changed."; echo '```'; exit 5
fi

resolve() { curl -fsS --max-time 10 "https://dns.google/resolve?name=$1&type=$2" 2>/dev/null | python3 -c 'import json,sys
try: print(" ".join(a["data"] for a in json.load(sys.stdin).get("Answer",[])) or "-")
except Exception: print("?")'; }
echo "Nameservers of $DOMAIN: $(resolve "$DOMAIN" NS)"
echo "$FQDN currently resolves to: $(resolve "$FQDN" A)"
if [ "$(resolve "$FQDN" A)" = "$IP" ]; then echo "✅ Already points to this server. Nothing to do."; echo '```'; exit 0; fi

if [ ! -s "$TOKEN_FILE" ]; then
  echo "⏸  No Hostinger API token on this server yet. Nothing was changed."
  echo "   See the instructions in the chat, then run the command again."
  echo '```'; exit 3
fi
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
api() { curl -sS --max-time 20 -o /tmp/dns-resp.json -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

code=$(api "$API")
echo "GET zone → HTTP $code"
case "$code" in
  200) ;;
  401) echo "❌ Token rejected (401). Create a new token and save it again."; echo '```'; exit 1;;
  403|404) echo "❌ $DOMAIN is not in the Hostinger account for this token (HTTP $code). Its DNS may be managed elsewhere: see nameservers above."; echo '```'; exit 1;;
  *) echo "❌ Unexpected response:"; head -c 400 /tmp/dns-resp.json; echo; echo '```'; exit 1;;
esac

existing=$(python3 - "$NAME" <<'PY'
import json, sys
name = sys.argv[1]
zone = json.load(open("/tmp/dns-resp.json"))
rows = zone if isinstance(zone, list) else zone.get("data", zone.get("zone", []))
hits = [r for r in rows if r.get("name") == name]
print(json.dumps(hits))
print(f"zone has {len(rows)} record sets", file=sys.stderr)
PY
)
echo "Existing records named '$NAME': $existing"
if [ "$existing" != "[]" ]; then
  echo "⏸  A record named '$NAME' already exists. Not overwriting it. Nothing was changed."; echo '```'; exit 4
fi

BODY=$(printf '{"overwrite":false,"zone":[{"name":"%s","type":"A","ttl":300,"records":[{"content":"%s"}]}]}' "$NAME" "$IP")
echo "Request: $BODY"
code=$(api -X POST "$API/validate" -d "$BODY"); echo "Validate → HTTP $code"
if [ "$code" != "200" ]; then head -c 600 /tmp/dns-resp.json; echo; echo "❌ Validation failed. Nothing was changed."; echo '```'; exit 1; fi
code=$(api -X PUT "$API" -d "$BODY"); echo "Update   → HTTP $code"
if [ "$code" != "200" ]; then head -c 600 /tmp/dns-resp.json; echo; echo "❌ Update failed."; echo '```'; exit 1; fi

api "$API" >/dev/null
python3 - "$NAME" <<'PY'
import json, sys
zone = json.load(open("/tmp/dns-resp.json"))
rows = zone if isinstance(zone, list) else zone.get("data", zone.get("zone", []))
print("Now in the zone:", json.dumps([r for r in rows if r.get("name") == sys.argv[1]]))
PY
echo "Public DNS now says: $(resolve "$FQDN" A)  (can take a few minutes to update)"
rm -f /tmp/dns-resp.json
echo "✅ DNS record added."
echo '```'
