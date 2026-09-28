#!/usr/bin/env bash
# Step: status — READ-ONLY. Health of the console and a quick look at everything else.
echo "## Status"; echo '```'
docker inspect agent-console --format 'agent-console: {{.State.Status}}, health={{if .State.Health}}{{.State.Health.Status}}{{end}}, started {{.State.StartedAt}}, restarts={{.RestartCount}}' 2>&1
echo "health endpoint: $(curl -s --max-time 5 http://127.0.0.1:3300/api/health)"
echo "memory: $(docker stats --no-stream --format '{{.MemUsage}}' agent-console 2>/dev/null)"
echo "other containers running: $(docker ps --format '{{.Names}}' | grep -vc '^agent-console$')  not running: $(docker ps -a --filter status=exited --filter status=restarting --format '{{.Names}}' | grep -v '^agent-console$' | paste -sd' ')"
echo "shared nginx: $(docker inspect -f '{{.State.Status}} since {{.State.StartedAt}}' tayyibt-nginx-1 2>&1)"
echo "tayyibt deployed commit: $(git -C /opt/actions-runner/_work/test/test log -1 --format='%h %cs %s' 2>/dev/null | cut -c1-70)"
echo '```'
