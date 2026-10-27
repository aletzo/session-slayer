#!/bin/sh
# Session Slayer hook: appends the Claude hook input as one line to ~/.session-slayer/events.jsonl.
# Must never block Claude, so it always exits 0.

dir="${SESSION_SLAYER_DIR:-$HOME/.session-slayer}"
mkdir -p "$dir" 2>/dev/null || exit 0
input="$(cat | tr -d '\n')" || exit 0
[ -n "$input" ] || exit 0
printf '{"ts":%s000,"hook":%s}\n' "$(date +%s)" "$input" >> "$dir/events.jsonl" 2>/dev/null
exit 0
