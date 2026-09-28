#!/usr/bin/env bash
# Step: inventory — READ-ONLY. Changes nothing on the server.
# Shows what already runs (e.g. tayibbat) so the install can avoid it.

section() { echo; echo "## $1"; echo; echo '```'; }
end() { echo '```'; }
have() { command -v "$1" >/dev/null 2>&1; }

section "System"
. /etc/os-release 2>/dev/null && echo "OS: $PRETTY_NAME"
echo "Kernel: $(uname -r)  Arch: $(uname -m)"
echo "Uptime: $(uptime -p 2>/dev/null)"
echo "CPU cores: $(nproc)"
free -h | head -2
df -h / /opt /var 2>/dev/null | awk '!seen[$1]++'
echo "Addresses: $(hostname -I 2>/dev/null)"
end

section "Node.js and process managers"
for bin in node npm pnpm pm2 bun deno; do
  if have "$bin"; then echo "$bin: $(command -v $bin) → $($bin --version 2>/dev/null | head -1)"; else echo "$bin: not installed"; fi
done
ls -d /root/.nvm /home/*/.nvm /usr/local/n /root/.fnm /home/*/.fnm 2>/dev/null | sed 's/^/version manager dir: /'
if have pm2; then echo; echo "pm2 processes (root):"; pm2 jlist 2>/dev/null | python3 -c 'import json,sys
try:
  for p in json.load(sys.stdin): print(" -", p["name"], p["pm2_env"].get("status"), "cwd="+str(p["pm2_env"].get("pm_cwd")))
except Exception as e: print(" (could not read)", e)' ; fi
for home in /home/*; do u=$(basename "$home"); if [ -d "$home/.pm2" ]; then echo "pm2 home found for user: $u"; fi; done
end

section "Listening ports (what is already taken)"
if have ss; then ss -ltnpH 2>/dev/null | awk '{print $4, $6}' | sed -E 's/users:\(\("([^"]+)".*/\1/' | sort -u
else netstat -ltnp 2>/dev/null | tail -n +3 | awk '{print $4, $7}'; fi
end

section "Web servers"
for bin in nginx apache2 httpd caddy traefik; do have "$bin" && echo "$bin: $(command -v $bin)"; done
have nginx && nginx -v 2>&1
systemctl is-active nginx apache2 caddy 2>/dev/null | paste -sd' ' | sed 's/^/active (nginx apache2 caddy): /'
end

section "Nginx sites (names, ports, targets only)"
if [ -d /etc/nginx ]; then
  for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [ -e "$f" ] || continue
    echo "### $f"
    grep -hE '^\s*(server_name|listen|proxy_pass|root)\b' "$f" 2>/dev/null | sed 's/^\s*/  /'
  done
  echo; echo "Config test:"; nginx -t 2>&1 | tail -2
else echo "No /etc/nginx"; fi
end

section "TLS certificates (Let's Encrypt)"
if have certbot; then certbot certificates 2>/dev/null | grep -E "Certificate Name|Domains|Expiry" ; else ls /etc/letsencrypt/live 2>/dev/null || echo "certbot not installed"; fi
end

section "Running services (excluding system basics)"
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null \
  | awk '{print $1}' | grep -vE '^(systemd|dbus|ssh|sshd|cron|getty|user@|polkit|rsyslog|networkd|udisks|unattended|irqbalance|snapd|multipathd|ModemManager|serial-getty|qemu-guest|chrony|packagekit|accounts-daemon|atd|fwupd|thermald|upower|containerd)' 
end

section "Custom systemd units"
ls /etc/systemd/system/*.service 2>/dev/null | xargs -r -n1 basename
end

section "Docker"
if have docker; then docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}' 2>/dev/null || echo "docker present, not running"; else echo "docker not installed"; fi
end

section "Databases"
for svc in postgresql mysql mariadb mongod redis-server redis; do systemctl is-active "$svc" >/dev/null 2>&1 && echo "$svc: running"; done
echo "(listed only if running)"
end

section "Top processes by memory (name only)"
ps -eo user,comm,%mem,%cpu --sort=-%mem 2>/dev/null | head -15
end

section "Folders"
echo "/opt:"; ls -la /opt 2>/dev/null | tail -n +2
echo; echo "/var/www:"; ls -la /var/www 2>/dev/null | tail -n +2
echo; echo "/home:"; ls /home 2>/dev/null
end

section "Firewall"
if have ufw; then ufw status 2>/dev/null | head -20; else echo "ufw not installed"; fi
end

section "Package manager and tools"
for bin in apt-get dnf yum curl git sqlite3 python3; do have "$bin" && echo "$bin: yes" || echo "$bin: no"; done
end
