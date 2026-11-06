---
name: session-slayer
description: "Use when: the user asks to set up, start or open the Session Slayer board, see all running agent sessions (Claude Code, opencode, Codex), asks for a 'new session', 'another session', 'separate session', or one session per item from a list (tickets, tasks), or types '/session-slayer'. A new session is NOT a subagent: never use the Agent tool for it."
argument-hint: "[setup | board | spawn <folder> <prompt> | batch <items> [instructions]]"
user-invocable: true
---

# Session Slayer

A local kanban board of all running AI coding sessions, plus starting new real sessions in WezTerm tabs. The app lives in `<SKILL_DIR>/app` (see its `README.md`).

## Pick the task

| User wants | Do |
|---|---|
| First use, or `~/.session-slayer/config.json` missing | Read `SETUP.md` and follow it |
| The board ("show my sessions", "open the board") | **Board** below |
| One new session | `SPAWN.md`, section "One session" |
| One session per item from a list | `SPAWN.md`, section "Batch" |

## Board

1. If `~/.session-slayer/config.json` is missing, run setup first (`SETUP.md`).
2. Reuse a running board: read `~/.session-slayer/instance.json` (`{ "port", "pid" }`). If `kill -0 <pid>` works and `curl -s http://127.0.0.1:<port>/api/repos` answers, it runs.
3. Else start it. `pnpm start` runs the board as a detached process (it keeps running after this session ends), waits until it answers (up to 2 minutes), prints the URL and exits. It is a normal command, not a background job:

```bash
cd <SKILL_DIR>/app && { [ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh && nvm use >/dev/null; node -v; } && pnpm start
```

The app needs Node 26 (`app/.nvmrc`). If `node -v` prints a lower version and there is no nvm, stop and run setup step 1.

The server takes the first free port from 45300 to 45399. Board output goes to `~/.session-slayer/board.log`.

4. Open `http://127.0.0.1:<port>` (`open <url>`) and give the user the URL in one line.

## Do not

- Use the Agent tool for a "new session".
- Start a second board when one already runs.
