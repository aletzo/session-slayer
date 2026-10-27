#!/bin/sh
# Session Slayer hook: appends the hook input as one line to ~/.session-slayer/events.jsonl.
# $1 is the tool name (e.g. "codex"); without it the line is a Claude Code event.
# Must never block the agent, so it always exits 0.

dir="${SESSION_SLAYER_DIR:-$HOME/.session-slayer}"
mkdir -p "$dir" 2>/dev/null || exit 0
input="$(cat | tr -d '\n')" || exit 0
[ -n "$input" ] || exit 0
tool="$(printf '%s' "${1:-}" | tr -cd 'a-z')"
if [ -n "$tool" ]; then
  printf '{"ts":%s000,"tool":"%s","hook":%s}\n' "$(date +%s)" "$tool" "$input" >> "$dir/events.jsonl" 2>/dev/null
else
  printf '{"ts":%s000,"hook":%s}\n' "$(date +%s)" "$input" >> "$dir/events.jsonl" 2>/dev/null
fi
exit 0
