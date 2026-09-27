#!/usr/bin/env bash
# One-command entry point for the VPS loop. Run on the server:
#
#   curl -fsSL https://raw.githubusercontent.com/Abdelrahman-sadek/agent-console/claude/agents-framework-eval-hrmlxu/deploy/vps.sh | sudo bash
#
# It fetches the latest scripts with git (so edits pushed to GitHub apply on the next run),
# runs the current step from deploy/STEP, and publishes a redacted report to a PRIVATE repo.
set -euo pipefail

BRANCH="${AGENT_CONSOLE_BRANCH:-claude/agents-framework-eval-hrmlxu}"
REPO_URL="https://github.com/Abdelrahman-sadek/agent-console.git"
BASE="/opt/agent-framework"
SRC="$BASE/src"

if [ "$(id -u)" -ne 0 ]; then echo "Please run with sudo (it needs to read service and port information)."; exit 1; fi

# git fetches the scripts; the ssh client sends reports. Both are small, standard packages.
need=""
command -v git >/dev/null 2>&1 || need="$need git"
command -v ssh-keygen >/dev/null 2>&1 || need="$need ssh"
if [ -n "$need" ]; then
  echo "[vps] Installing missing tools:$need"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq $(echo "$need" | sed 's/ssh/openssh-client/')
  elif command -v dnf >/dev/null; then dnf install -y -q $(echo "$need" | sed 's/ssh/openssh-clients/')
  elif command -v yum >/dev/null; then yum install -y -q $(echo "$need" | sed 's/ssh/openssh-clients/')
  else echo "Please install:$need, then run again."; exit 1; fi
fi

mkdir -p "$BASE"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch -q --depth 1 origin "$BRANCH"
  git -C "$SRC" checkout -q -B "$BRANCH" FETCH_HEAD
else
  git clone -q --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC"
fi

exec bash "$SRC/deploy/run.sh"
