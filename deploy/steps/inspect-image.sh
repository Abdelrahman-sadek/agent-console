#!/usr/bin/env bash
# Step: inspect-image — READ-ONLY. Looks inside the agent-console image with short-lived
# test containers (removed immediately). Does not restart or change any container.
section() { echo; echo "## $1"; echo; echo '```'; }
end() { echo '```'; }
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
IMG=agent-console:latest

section "Source on the server"
echo "scripts/app commit: $(git -C "$SRC" rev-parse --short HEAD)"
echo "framework submodule: $(git -C "$SRC" submodule status 2>&1)"
ls -la "$SRC/vendor/agents-framework/packages" 2>&1 | head -20
echo; echo "build context files that .dockerignore would send (vendor top level):"; ls -la "$SRC/vendor/agents-framework" | head -30
end

section "Image"
docker image inspect "$IMG" --format 'id={{.Id}} created={{.Created}}' 2>&1
docker version --format 'docker client {{.Client.Version}} server {{.Server.Version}}' 2>&1
docker buildx version 2>&1 | head -1
end

section "Inside the image: framework links and their targets"
docker run --rm --entrypoint sh "$IMG" -c '
cd /app
echo "package.json deps:"; grep -A8 "\"dependencies\"" package.json
echo; ls -la node_modules/@agent-farmework/ 2>&1
for p in core knowledge llm production security tools; do printf "%-11s → %s  dist/index.js: %s\n" $p "$(readlink -f node_modules/@agent-farmework/$p 2>&1)" "$( [ -f node_modules/@agent-farmework/$p/dist/index.js ] && echo yes || echo MISSING)"; done
echo; echo "vendor packages in image:"; ls vendor/agents-framework/packages 2>&1
' 2>&1
end

section "Inside the image: can the server modules load?"
docker run --rm --entrypoint sh "$IMG" -c '
cd /app
node -e "import(\"@agent-farmework/production\").then(()=>console.log(\"plain node: OK\")).catch(e=>console.log(\"plain node: ERR\", e.message.split(\"\n\")[0]))"
node --import tsx -e "import(\"./server/db.ts\").then(()=>console.log(\"tsx server/db.ts: OK\")).catch(e=>console.log(\"tsx server/db.ts: ERR\", e.message.split(\"\n\")[0]))"
' 2>&1
end
