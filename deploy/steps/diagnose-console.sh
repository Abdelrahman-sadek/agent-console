#!/usr/bin/env bash
# Step: diagnose-console — READ-ONLY. Why is the agent-console container not healthy?
section() { echo; echo "## $1"; echo; echo '```'; }
end() { echo '```'; }
section "Container state"
docker inspect agent-console --format 'status={{.State.Status}} running={{.State.Running}} restarting={{.State.Restarting}} exit={{.State.ExitCode}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} error={{.State.Error}}' 2>&1
docker inspect agent-console --format 'user={{.Config.User}} image={{.Config.Image}} mounts={{range .Mounts}}{{.Source}}→{{.Destination}} {{end}}' 2>&1
end
section "Last 60 log lines"
docker logs --tail 60 agent-console 2>&1
end
section "Health check log"
docker inspect agent-console --format '{{range .State.Health.Log}}{{.ExitCode}} {{.Output}}{{"\n"}}{{end}}' 2>&1 | tail -5
end
section "Data folder and env file (permissions only)"
ls -la /opt/agent-framework/ /opt/agent-framework/data 2>&1
echo "env file keys: $(cut -d= -f1 /opt/agent-framework/app.env 2>/dev/null | paste -sd' ')"
end
section "Try starting it once in the foreground (10 s, then removed)"
docker run --rm --name agent-console-probe --env-file /opt/agent-framework/app.env -v /opt/agent-framework/data:/data agent-console:latest \
  sh -c 'timeout 10 node --import tsx server/index.ts; echo "exit code: $?"' 2>&1 | tail -25
end
