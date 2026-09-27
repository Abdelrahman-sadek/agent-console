#!/usr/bin/env bash
# Step: inspect-proxy — READ-ONLY. Changes nothing.
# Ports 80/443 belong to the tayyibt-nginx-1 container, the front door for every site.
# Before adding anything, learn how it is configured and how other sites were added.

section() { echo; echo "## $1"; echo; echo '```'; }
end() { echo '```'; }
NGX="tayyibt-nginx-1"

section "nginx container: mounts (host path → container path)"
docker inspect "$NGX" --format '{{range .Mounts}}{{.Type}}  {{.Source}} → {{.Destination}}  (rw={{.RW}}){{"\n"}}{{end}}' 2>&1
end

section "nginx container: networks and compose project"
docker inspect "$NGX" --format '{{range $n, $v := .NetworkSettings.Networks}}network: {{$n}}{{"\n"}}{{end}}' 2>&1
docker inspect "$NGX" --format 'compose project: {{index .Config.Labels "com.docker.compose.project"}}{{"\n"}}compose dir: {{index .Config.Labels "com.docker.compose.project.working_dir"}}{{"\n"}}compose files: {{index .Config.Labels "com.docker.compose.project.config_files"}}{{"\n"}}restart policy: {{.HostConfig.RestartPolicy.Name}}' 2>&1
end

section "nginx config files inside the container"
docker exec "$NGX" sh -c 'ls -la /etc/nginx/conf.d/ /etc/nginx/sites-enabled/ 2>/dev/null' 2>&1
end

section "Every server block: file, server_name, listen, proxy_pass, certificate"
docker exec "$NGX" nginx -T 2>/dev/null | grep -E '^# configuration file|^\s*(server_name|listen|proxy_pass|ssl_certificate |include|resolver)\b' | sed 's/^\s*/  /'
end

section "nginx config test (current state)"
docker exec "$NGX" nginx -t 2>&1
end

section "Docker networks"
docker network ls --format '{{.Name}}  {{.Driver}}' 2>&1
end

section "Is the tayyibt project a git checkout? (would a deploy overwrite added files?)"
TDIR=$(docker inspect "$NGX" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null)
echo "project dir: ${TDIR:-unknown}"
if [ -n "$TDIR" ] && [ -d "$TDIR/.git" ]; then
  git -C "$TDIR" remote -v 2>/dev/null | head -2 | sed -E 's#(https?://)[^@/]+@#\1***@#'
  echo "branch: $(git -C "$TDIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo "tracked nginx files:"; git -C "$TDIR" ls-files 2>/dev/null | grep -iE 'nginx|\.conf$' | head -40
  echo "untracked/modified nginx files (added on the server, not in git):"; git -C "$TDIR" status --porcelain 2>/dev/null | grep -iE 'nginx|\.conf' | head -40
  echo "gitignore rules mentioning nginx/conf:"; grep -iE 'nginx|conf' "$TDIR/.gitignore" 2>/dev/null
else echo "not a git checkout (or unknown)"; fi
end

section "How certificates are issued and renewed"
ls /opt/certbot-hooks 2>/dev/null && for f in /opt/certbot-hooks/*; do echo "--- $f"; head -30 "$f"; done
echo; echo "renewal method per certificate:"
for f in /etc/letsencrypt/renewal/*.conf; do [ -e "$f" ] || continue; echo "$(basename "$f"): $(grep -hE '^(authenticator|webroot_path|installer)|^\s*[a-z0-9.-]+ = /' "$f" | tr '\n' ' ')"; done
echo; echo "certbot timer:"; systemctl list-timers --no-pager 2>/dev/null | grep -i certbot
end

section "Address for the console (checks only)"
for h in agents.145-14-158-100.sslip.io agents.m3lsh.com agents.higher-institute.tech; do
  printf '%-40s → %s\n' "$h" "$(getent hosts "$h" | awk '{print $1}' | head -1 || true)"
done
echo; echo "port 3300 on localhost: $(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE ':3300$' && echo TAKEN || echo free)"
end

section "Docker and compose versions"
docker --version; docker compose version 2>&1 | head -1
end
