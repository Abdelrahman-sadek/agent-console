#!/usr/bin/env bash
# Step: inspect-nginx — READ-ONLY. Changes nothing.
# Other sites' configs (cema.conf, correspondence.conf, …) live inside the tayyibt nginx
# container but are not mounted from the host. Find how they get there and survive
# tayyibt deploys (which rsync --delete /opt/tayyibt), so the console follows that pattern.

section() { echo; echo "## $1"; echo; echo '```'; }
end() { echo '```'; }
NGX="tayyibt-nginx-1"
show() { [ -f "$1" ] && { echo "--- $1 ($(wc -l < "$1") lines)"; cat "$1"; echo; } || echo "--- $1: not found"; }

section "1. nginx container: all mounts incl. volumes, created, image"
docker inspect "$NGX" --format '{{json .Mounts}}' | python3 -m json.tool 2>/dev/null
docker inspect "$NGX" --format 'created: {{.Created}}  started: {{.State.StartedAt}}  image: {{.Config.Image}}'
end

section "2. Files inside the container that differ from the image (docker diff)"
docker diff "$NGX" 2>/dev/null | grep -E 'etc/nginx' | head -60
end

section "3. Where the site configs come from on the host (search by file name and content)"
for f in cema.conf correspondence.conf higher-institute.conf institutes-dev.conf me.conf medical-barcode.conf mohesr-agents.conf; do
  echo "$f:"; find /opt /root /home /etc -maxdepth 5 -name "$f" -not -path '*/node_modules/*' 2>/dev/null | sed 's/^/   /'
done
echo; echo "scripts that copy configs or certs into the nginx container:"
find /opt /root /home -maxdepth 5 -type f \( -name '*.sh' -o -name '*.yml' -o -name '*.yaml' -o -name 'Makefile' \) -size -300k -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '/opt/agent-framework/*' 2>/dev/null \
  | xargs -r grep -nE "docker cp|tayyibt-nginx|conf\.d|certs-[a-z]|nginx -s reload|nginx.*reload" 2>/dev/null | head -60
end

section "4. tayyibt compose: the nginx service"
python3 - <<'PY'
import re
p="/opt/tayyibt/docker-compose.vps.yml"
try: txt=open(p).read()
except Exception as e: print("cannot read", p, e); raise SystemExit
lines=txt.splitlines(); out=[]; inside=False
for l in lines:
    if re.match(r"^  nginx:\s*$", l): inside=True
    elif inside and re.match(r"^  \S", l): break
    if inside: out.append(l)
print("\n".join(out) or "(no 'nginx:' service found)")
nets=[l for l in lines if re.match(r"^networks:|^  [a-z0-9_-]+:\s*$", l)]
PY
end

section "5. tayyibt deploy: what survives rsync --delete (excludes) and what cd-deploy.sh does"
wf=/opt/actions-runner/_work/test/test/.github/workflows/deploy.yml
sed -n '40,95p' "$wf" 2>/dev/null
echo; show /opt/tayyibt/scripts/cd-deploy.sh
end

section "6. Certificate scripts used by tayyibt and other projects"
show /opt/tayyibt/scripts/renew-cert.sh
for p in cema correspondence-service medical-barcode mohesr-agents; do ls /opt/$p 2>/dev/null | sed "s#^#/opt/$p/#"; done
end

section "7. tayyibt nginx.conf on the host (default.conf): includes and server names"
grep -nE "include|server_name|listen|conf\.d" /opt/tayyibt/docker/nginx/nginx.conf 2>/dev/null | head -40
end
