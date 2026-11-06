#!/bin/sh
# Session Slayer status line wrapper: saves Claude's status line JSON to
# ~/.session-slayer/status/<session_id>.json, then runs the original status line
# command (passed as $1) with the same input, so the status line looks unchanged.

input="$(cat)"
dir="${SESSION_SLAYER_DIR:-$HOME/.session-slayer}/status"
sid="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p' | head -n 1)"
if [ -n "$sid" ] && mkdir -p "$dir" 2>/dev/null; then
  printf '%s' "$input" > "$dir/$sid.json.tmp" 2>/dev/null && mv "$dir/$sid.json.tmp" "$dir/$sid.json" 2>/dev/null
fi
[ -n "$1" ] && printf '%s' "$input" | sh -c "$1"
exit 0
