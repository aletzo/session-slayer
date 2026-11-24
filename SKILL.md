---
name: session-slayer
description: "Use when: the user asks to set up, start or open the Session Slayer board, see all running agent sessions (Claude Code, opencode, Codex, pi), asks for a 'new session', 'another session', 'separate session', or one session per item from a list (tickets, tasks), asks for a sitrep, status or overview of the sessions, asks to start session control (one session that controls the others), asks to 'restore sessions' after a restart or reboot, or types '/session-slayer'. A new session is NOT a subagent: never use the Agent tool for it."
argument-hint: "[setup | board | sitrep | control | spawn <folder> <prompt> | batch <items> [instructions]]"
user-invocable: true
---

# Session Slayer

A local kanban board of all running AI coding sessions, plus starting new real sessions in WezTerm tabs. The app lives in `<SKILL_DIR>/app` (see its `README.md`).

## Pick the task

| User wants | Do |
|---|---|
| First use, or `~/.session-slayer/config.json` missing | Read `SETUP.md` and follow it |
| The board ("show my sessions", "open the board") | **Board** below |
| A sitrep, status or overview of the sessions | **Sitrep** below |
| Start session control, or you were started with `/session-slayer control` | `CONTROL.md` |
| One new session | `SPAWN.md`, section "One session" |
| One session per item from a list | `SPAWN.md`, section "Batch" |
| "Restore sessions" after a reboot | **Restore** below |
| Change the tool for new sessions (Claude Code, opencode, Codex, pi) | `cd <SKILL_DIR>/app && pnpm -s slayer default-tool <claude\|opencode\|codex\|pi>`. Without a tool it prints the current one. The board's "New session" dialog starts on it. |

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

## Sitrep

1. Make sure the board runs (**Board** steps 1-3; do not open the page).
2. Run `cd <SKILL_DIR>/app && pnpm -s slayer sitrep`. It prints one markdown table of all sessions (Claude Code, opencode, Codex): sessions that need input first, then each session's state, ticket, repo, branch and last reply (or its first prompt if it has not replied yet).
3. Give the user the table, then a short list: which sessions wait for them and on what. Read a session's transcript only when its last reply is not enough.

## Restore

The board saves the open interactive sessions to `~/.session-slayer/open-sessions.json` on every poll. After a reboot, this command reopens each one in a new WezTerm tab (`claude --resume`, `opencode -s`, `codex resume`, `pi --session`):

```bash
cd <SKILL_DIR>/app && { [ -s ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh && nvm use >/dev/null; node -v; } && pnpm slayer restore
```

It restores only sessions open before the last boot, and only once. Report the printed list in one table.

## Do not

- Use the Agent tool for a "new session".
- Start a second board when one already runs.
