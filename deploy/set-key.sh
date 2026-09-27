#!/usr/bin/env bash
# Store a model-provider key on the server only. Run on the VPS:
#
#   sudo bash /opt/agent-framework/src/deploy/set-key.sh anthropic     # or: openai | openrouter | ollama
#
# The key is typed hidden, written to the root-only env file, and never printed or reported.
# It takes effect the next time the console container is recreated (step: update-console).
set -euo pipefail
ENV_FILE="${AGENT_CONSOLE_ENV:-/opt/agent-framework/app.env}"
[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo."; exit 1; }
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found. Install the console first."; exit 1; }

case "${1:-}" in
  anthropic)  VAR=ANTHROPIC_API_KEY;  PROMPT="Anthropic API key (sk-ant-...)" ;;
  openai)     VAR=OPENAI_API_KEY;     PROMPT="OpenAI API key (sk-...)" ;;
  openrouter) VAR=OPENROUTER_API_KEY; PROMPT="OpenRouter API key (sk-or-...)" ;;
  ollama)     VAR=OLLAMA_BASE_URL;    PROMPT="Ollama OpenAI-compatible URL (e.g. http://host.docker.internal:11434/v1)" ;;
  remove)     VAR="${2:?which variable? e.g. remove OPENAI_API_KEY}"; PROMPT="" ;;
  *) echo "Usage: sudo bash $0 anthropic|openai|openrouter|ollama   (or: remove VAR_NAME)"; exit 1 ;;
esac

umask 077
tmp="$(mktemp "$ENV_FILE.XXXXXX")"
grep -v "^${VAR}=" "$ENV_FILE" > "$tmp" || true
if [ -n "$PROMPT" ]; then
  if [ "$VAR" = OLLAMA_BASE_URL ]; then read -r -p "$PROMPT: " VALUE < /dev/tty
  else read -r -s -p "$PROMPT (hidden): " VALUE < /dev/tty; echo; fi
  VALUE="$(printf '%s' "$VALUE" | tr -d '[:space:]')"
  [ -n "$VALUE" ] || { rm -f "$tmp"; echo "Nothing entered; unchanged."; exit 1; }
  printf '%s=%s\n' "$VAR" "$VALUE" >> "$tmp"
fi
chown root:root "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$ENV_FILE"
if [ -n "$PROMPT" ]; then echo "Saved ${VAR} in ${ENV_FILE} (root-only)."; else echo "Removed ${VAR}."; fi
echo "Variables now set: $(cut -d= -f1 "$ENV_FILE" | paste -sd' ')"
echo "Next: put 'update-console' in deploy/STEP (or ask Claude) and run the usual one command."
