#!/usr/bin/env bash
# Runs the current step (deploy/STEP), captures everything it prints, redacts secrets,
# and publishes the report to the private reports repo. Called by deploy/vps.sh.
set -uo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${AGENT_CONSOLE_BASE:-/opt/agent-framework}"
REPORT_REPO="${REPORT_REPO:-Abdelrahman-sadek/agent-console-vps}"
KEY="${REPORT_KEY:-/root/.ssh/agent-console-vps}"
STEP="$(tr -d '[:space:]' < "$SRC/deploy/STEP")"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_REPORTS="$BASE/reports"
mkdir -p "$LOCAL_REPORTS"
REPORT="$LOCAL_REPORTS/$TS-$STEP.md"

[ -f "$SRC/deploy/steps/$STEP.sh" ] || { echo "Unknown step '$STEP'"; exit 1; }

# Remove anything that looks like a secret before the report leaves the server.
redact() {
  sed -E \
    -e 's/(Bearer|Basic|Token)[[:space:]]+[A-Za-z0-9._~+\/=-]{8,}/\1 ***/g' \
    -e 's/((pass(word)?|passwd|secret|token|api[_-]?key|auth[a-z_]*|credential[s]?|private[_-]?key)[A-Za-z0-9_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?)[^[:space:],;"'"'"']+/\1***/Ig' \
    -e 's#(://[^/:@[:space:]]+:)[^@[:space:]]+@#\1***@#g' \
    -e 's/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/\1***/g' \
    -e 's/(sk-[a-z-]*)[A-Za-z0-9_-]{16,}/\1***/g' \
    -e 's/AKIA[0-9A-Z]{16}/AKIA***/g' \
    -e '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/c\[private key removed]'
}

{
  echo "# VPS report: \`$STEP\`"
  echo
  echo "- Time (UTC): $TS"
  echo "- Scripts commit: $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "- Host: $(hostname)"
  echo
  bash "$SRC/deploy/steps/$STEP.sh" 2>&1
  rc=$?
  echo "$rc" > "$LOCAL_REPORTS/.last-exit"
  echo
  if [ "$rc" -eq 0 ]; then echo "**Result: ✅ step succeeded (exit 0)**"; else echo "**Result: ❌ step failed (exit $rc)**"; fi
} | redact | tee "$REPORT"
STEP_EXIT="$(cat "$LOCAL_REPORTS/.last-exit" 2>/dev/null || echo 1)"

# ---------------------------------------------------------------- publish to the private repo
if [ "${REPORT_DRY_RUN:-0}" = "1" ]; then echo; echo "[vps] Dry run: report saved to $REPORT"; exit 0; fi

mkdir -p "$(dirname "$KEY")"
if [ ! -f "$KEY" ] && ! ssh-keygen -q -t ed25519 -N "" -C "agent-console-vps-reports@$(hostname)" -f "$KEY"; then
  echo "[vps] ❌ Could not create an SSH key (is ssh-keygen installed?). Report saved locally at $REPORT"; exit 1
fi
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
OPS="$BASE/reports-repo"
publish() {
  if [ ! -d "$OPS/.git" ]; then
    rm -rf "$OPS" && git clone -q "git@github.com:$REPORT_REPO.git" "$OPS" || return 1
  fi
  git -C "$OPS" pull -q --rebase origin HEAD 2>/dev/null || true
  mkdir -p "$OPS/reports"
  cp "$LOCAL_REPORTS"/*.md "$OPS/reports/" 2>/dev/null
  cp "$REPORT" "$OPS/latest.md"
  git -C "$OPS" add -A
  git -C "$OPS" -c user.name="vps-reporter" -c user.email="vps-reporter@localhost" commit -q -m "Report: $STEP ($TS)" || true
  git -C "$OPS" push -q origin HEAD
}

echo
if publish; then
  echo "[vps] ✅ Report published to https://github.com/$REPORT_REPO/blob/HEAD/latest.md"
  echo "[vps] Tell Claude \"done\" in the chat. Then run the same command again when asked."
else
  echo "[vps] ⚠️  Could not publish the report yet (saved locally at $REPORT)."
  echo "[vps] One-time setup: add this server's key to the PRIVATE repo $REPORT_REPO:"
  echo "      1. Open https://github.com/$REPORT_REPO/settings/keys/new"
  echo "      2. Title: vps   Key: the line below   Tick 'Allow write access'   Add key"
  echo
  cat "$KEY.pub"
  echo
  echo "[vps] Then run the same command again. Earlier reports are sent too."
fi
exit "$STEP_EXIT"
