#!/usr/bin/env bash
# Step: survey — READ-ONLY. Changes nothing.
# Reads every project on the server before anything is added, so the install
# conflicts with none of them: containers, ports, networks, volumes, deploy
# pipelines, scheduled jobs, the shared nginx and certificates.
# Environment variables are listed by NAME only, never values.

section() { echo; echo "## $1"; echo; echo '```'; }
end() { echo '```'; }
NGX="tayyibt-nginx-1"

# ---------------------------------------------------------------- 1. projects
section "1. Docker Compose projects (name → folder → containers)"
docker ps -a --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Names}}|{{.Status}}' 2>/dev/null \
  | sort | awk -F'|' '{ key=($1==""?"(no compose project)":$1" → "$2); if (key!=last) {print "\n" key; last=key} print "   - " $3 "  [" $4 "]" }'
end

section "2. Every container: image, published ports, networks, host folders mounted, restart, memory limit"
for c in $(docker ps -a --format '{{.Names}}' 2>/dev/null | sort); do
  docker inspect "$c" --format '{{.Name}}
   image: {{.Config.Image}}
   ports: {{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}:{{.HostPort}}->{{$p}} {{end}}{{end}}
   networks: {{range $n, $v := .NetworkSettings.Networks}}{{$n}} {{end}}
   mounts: {{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}→{{.Destination}} {{else}}vol:{{.Name}}→{{.Destination}} {{end}}{{end}}
   restart: {{.HostConfig.RestartPolicy.Name}}   mem limit: {{.HostConfig.Memory}}
   env names: {{range .Config.Env}}{{index (split . "=") 0}} {{end}}' 2>/dev/null
done
end

section "3. Live resource use per container"
docker stats --no-stream --format '{{.Name}}  cpu={{.CPUPerc}}  mem={{.MemUsage}}' 2>/dev/null | sort
end

section "4. Docker networks (and which containers are on them)"
for n in $(docker network ls --format '{{.Name}}' 2>/dev/null); do
  echo "$n: $(docker network inspect "$n" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null)"
done
end

section "5. Docker volumes, images and disk use"
docker system df 2>/dev/null
echo; docker volume ls --format '{{.Name}}' 2>/dev/null | sort | paste -sd' ' | fold -w 160
end

# ---------------------------------------------------------------- 2. folders and deploys
section "6. Project folders in /opt and /home: git remote, branch, last commit, compose/deploy files"
for d in /opt/*/ /home/*/*/; do
  d="${d%/}"; case "$d" in /opt/containerd|/opt/agent-framework) continue;; esac
  [ -d "$d" ] || continue
  echo "### $d  (owner $(stat -c %U "$d"))"
  if [ -d "$d/.git" ]; then
    echo "   git: $(git -C "$d" remote get-url origin 2>/dev/null | sed -E 's#(https?://)[^@/]+@#\1***@#')  branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)  last=$(git -C "$d" log -1 --format='%cs %s' 2>/dev/null | cut -c1-70)"
    echo "   local changes: $(git -C "$d" status --porcelain 2>/dev/null | wc -l) files"
  fi
  ls "$d" 2>/dev/null | grep -iE 'compose|docker|deploy|\.sh$|nginx|Makefile|\.env' | sed 's/^/   file: /' | head -15
done
end

section "7. Self-hosted GitHub runners (they deploy automatically)"
for svc in $(systemctl list-units --type=service --no-legend 'actions.runner*' 2>/dev/null | awk '{print $1}'); do
  echo "### $svc: $(systemctl is-active "$svc")"
  dir=$(systemctl show -p WorkingDirectory --value "$svc" 2>/dev/null); echo "   runner dir: $dir"
done
for wf in $(find /opt/actions-runner* /home/*/actions-runner* -path '*/_work/*/.github/workflows/*' -name '*.y*ml' 2>/dev/null | head -40); do
  echo "--- workflow: $wf"
  grep -nE 'runs-on|docker (compose|system|image|network|volume|container)|prune|nginx|certbot|conf\.d|rm -rf|systemctl|/opt/' "$wf" 2>/dev/null | head -25 | sed 's/^/   /'
done
end

section "8. Anything that could delete other projects' containers, images or networks (prune / rm)"
find /opt /home /etc/cron.d -maxdepth 4 -type f -size -300k \( -name '*.sh' -o -name '*.yml' -o -name '*.yaml' -o -name 'Makefile' -o -name '*.conf' -o -name 'Dockerfile*' \) \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/_diag/*' -not -path '/opt/agent-framework/*' -not -path '/opt/containerd/*' 2>/dev/null \
  | xargs -r grep -nIE 'docker[- ](system|image|container|network|volume|builder)? ?prune|docker rm -f|(docker compose|docker-compose) down -v' 2>/dev/null | grep -v '/agent-framework/' | head -40
end

section "9. Scheduled jobs (cron and timers)"
for u in root $(ls /home); do l=$(crontab -l -u "$u" 2>/dev/null | grep -vE '^\s*(#|$)'); [ -n "$l" ] && { echo "crontab $u:"; echo "$l" | sed 's/^/   /'; }; done
ls /etc/cron.d 2>/dev/null | sed 's/^/cron.d: /'
for f in /etc/cron.d/*; do [ -f "$f" ] && grep -vE '^\s*(#|$)' "$f" | sed "s#^#   $(basename "$f"): #"; done
echo; systemctl list-timers --all --no-pager --no-legend 2>/dev/null | awk '{print $(NF-1), $NF}'
end

# ---------------------------------------------------------------- 3. shared front door
section "10. Shared nginx ($NGX): mounts, networks, compose project"
docker inspect "$NGX" --format '{{range .Mounts}}{{.Type}}  {{.Source}} → {{.Destination}}  (rw={{.RW}}){{"\n"}}{{end}}' 2>&1
docker inspect "$NGX" --format 'compose dir: {{index .Config.Labels "com.docker.compose.project.working_dir"}}  files: {{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>&1
end

section "11. Shared nginx: every site (file, server_name, listen, proxy_pass, certificate)"
docker exec "$NGX" sh -c 'ls -la /etc/nginx/conf.d/ 2>/dev/null' 2>&1
echo
docker exec "$NGX" nginx -T 2>/dev/null | grep -E '^# configuration file|^\s*(server_name|listen|proxy_pass|ssl_certificate |include|resolver|upstream|server [a-z0-9_.-]+:)' | sed 's/^\s*/  /'
echo; docker exec "$NGX" nginx -t 2>&1
end

section "12. Is the nginx config in git? (would a tayyibt deploy overwrite an added file?)"
TDIR=$(docker inspect "$NGX" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null)
if [ -n "$TDIR" ] && [ -d "$TDIR/.git" ]; then
  echo "tracked nginx files:"; git -C "$TDIR" ls-files 2>/dev/null | grep -iE 'nginx|\.conf$' | head -40 | sed 's/^/   /'
  echo "added on the server (not in git):"; git -C "$TDIR" status --porcelain --untracked-files=all 2>/dev/null | grep -iE 'nginx|\.conf' | head -40 | sed 's/^/   /'
  echo "gitignore rules for nginx/conf:"; grep -iE 'nginx|conf' "$TDIR/.gitignore" 2>/dev/null | sed 's/^/   /'
else echo "tayyibt folder is not a git checkout (or unknown): ${TDIR:-?}"; fi
end

section "13. Certificates: how they are issued and renewed"
for f in /opt/certbot-hooks/*; do [ -f "$f" ] && { echo "--- $f"; head -25 "$f"; }; done
echo; for f in /etc/letsencrypt/renewal/*.conf; do [ -e "$f" ] || continue; echo "$(basename "$f"): $(grep -hE '^(authenticator|installer|webroot_path)|^[a-z0-9.-]+ = /|^(pre|post|deploy|renew)_hook' "$f" | tr '\n' ' ')"; done
end

# ---------------------------------------------------------------- 4. names the console would use
section "14. Names and resources the console would use: free or taken?"
check() { printf '%-45s %s\n' "$1" "$2"; }
check "folder /opt/agent-framework"            "$(ls -A /opt/agent-framework 2>/dev/null | paste -sd' ' | sed 's/^/exists (ours, from these scripts): /')"
check "container name agent-console"           "$(docker ps -a --format '{{.Names}}' | grep -qx agent-console && echo TAKEN || echo free)"
check "network name agent-console"             "$(docker network ls --format '{{.Name}}' | grep -qx agent-console && echo TAKEN || echo free)"
check "host port 3300"                         "$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE ':3300$' && echo TAKEN || echo free)"
check "linux user agentconsole"                "$(id agentconsole >/dev/null 2>&1 && echo TAKEN || echo free)"
SUB="agent-console.higher-institute.tech"
check "nginx server_name $SUB"                 "$(docker exec "$NGX" nginx -T 2>/dev/null | grep -E 'server_name' | grep -qF "$SUB" && echo TAKEN || echo free)"
check "certificate for $SUB"                   "$(ls /etc/letsencrypt/live 2>/dev/null | grep -qx "$SUB" && echo exists || echo none yet)"
check "DNS $SUB"                               "$(getent hosts "$SUB" | awk '{print $1}' | head -1 | sed 's/^$/does not resolve (A record needed)/')"
check "wildcard DNS *.higher-institute.tech?"  "$(getent hosts "wildcard-check-$RANDOM.higher-institute.tech" | awk '{print $1}' | head -1 | sed 's/^$/no wildcard/')"
check "server public IPv4"                     "$(hostname -I | awk '{print $1}')"
end
