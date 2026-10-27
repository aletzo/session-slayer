# Session Slayer — Design

Date: 2026-10-27
Status: approved in brainstorming, waiting for spec review

## 1. Goal

A local tool to watch all running Claude Code sessions on one kanban board.

- See at a glance which sessions are **working**, which **need input**, and which are **idle**.
- Group sessions into lanes by tag (`fireline` ticket or repo) and filter by tag.
- Click a card to jump to that session in the terminal.
- Start, rename and close sessions from the board.
- The UI is used with the mouse only. No keyboard navigation is needed.

Version 1 supports Claude Code only. opencode can be added later (see section 9).

### Out of scope for version 1

- opencode sessions.
- Sending a name set in Session Slayer back into a running Claude session.
- Moving cards by drag and drop. Cards move on their own.
- Jumping to sessions that run in a terminal other than WezTerm (for example Warp).
- Browser-driven UI tests.

## 2. Key decisions

| Topic | Decision | Reason |
|---|---|---|
| Terminal | **WezTerm** replaces Warp for Claude sessions | `wezterm cli` can list panes and focus one by id. Warp cannot. Claude Code itself stays exactly the same. |
| UI | **Local web page** at `http://127.0.0.1:4545` | Fast to build, mouse friendly. Can be wrapped in a desktop app (Tauri) later without a rewrite. |
| How state is read | **Session list + hooks** | `claude agents --json` says which sessions are alive. Hooks tell "needs input" apart from "idle". |
| Hook transport | Hooks **append to a file**, they do not call the server | No events are lost when Session Slayer is not running. |
| Stack | Node + TypeScript, pnpm, React + Vite, Vitest | The stack the author uses every day. |

## 3. Architecture

One Node process. It listens only on `127.0.0.1:4545`, serves the page and a small HTTP API.

```
claude agents --json ──(every 2 s)──┐
~/.session-slayer/events.jsonl ─────┼─► board builder ─► SSE push ─► web page (React)
~/.session-slayer/names.json ───────┘                                    │ clicks
                                       wezterm cli ◄── HTTP API ◄────────┘
```

SSE (Server-Sent Events): a one-way channel where the server pushes updates to the page as they happen.

### Parts

Each part has one job. Parts marked "pure" only turn input into output (no files, no commands), so they are easy to test.

| File | Job |
|---|---|
| `src/sources/claudeAgents.ts` | Runs `claude agents --json` every 2 seconds. Returns the live sessions: `sessionId`, `pid`, `cwd`, `name`, `kind`, `status` (interactive) or `state` (background). |
| `src/sources/hookEvents.ts` | Reads new lines from `events.jsonl`. Keeps, per `sessionId`, the newest event and the first prompt. Compacts the file at start. |
| `src/tags.ts` (pure) | From `cwd`, first prompt and name: returns the repo tag, the `fireline` tag and the ticket key. |
| `src/board.ts` (pure) | Merges live sessions, events and names into cards: column, lane, tags, name, time in column. |
| `src/wezterm.ts` | Finds the WezTerm pane for a `pid`. Focuses, kills and spawns panes. |
| `src/names.ts` | Reads and writes `names.json` (names set in Session Slayer, by `sessionId`). |
| `src/server.ts` | HTTP API and SSE. |
| `src/installHooks.ts` | `pnpm slayer install-hooks`: adds Session Slayer's hook entries to `~/.claude/settings.json`. |
| `hooks/session-slayer-hook.sh` | The hook script: appends one JSON line to `events.jsonl`. |
| `web/` | React + Vite page: lanes, columns, cards, filter chips, buttons, banners. |

### Data folder

`~/.session-slayer/`

- `events.jsonl` — one line per hook event: the hook's JSON input plus a `ts` field (time in milliseconds).
- `names.json` — `{ "<sessionId>": "<name>" }`.

## 4. Hooks

### Hook script

`hooks/session-slayer-hook.sh` reads the hook input (JSON on stdin), adds `ts`, and appends it as one line to `~/.session-slayer/events.jsonl`.

Rules for the script:

- It always exits with code 0, even on error. It must never block or slow down Claude.
- It does nothing else: no network calls, no parsing beyond adding `ts`.
- It creates `~/.session-slayer/` if the folder is missing.

### Hook events used

`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`.

### Install command

`pnpm slayer install-hooks`:

- Adds one entry per event above to `~/.claude/settings.json`, pointing to the hook script.
- Keeps all existing hooks as they are (today: the `rtk` `PreToolUse` hook and the `herdr` `SessionStart` hook).
- Running it twice does not add duplicates. An entry counts as a duplicate when its `command` points to `session-slayer-hook.sh`.
- Writes a backup `~/.claude/settings.json.session-slayer.bak` before changing the file.

## 5. Board rules

### Which sessions show

- Only sessions in the latest `claude agents --json` output.
- A `SessionEnd` event removes the card at once, without waiting for the next poll.

### Column

The newest hook event of the session decides the column:

| Newest event | Column |
|---|---|
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | **Working** |
| `PreToolUse` with `tool_name` = `AskUserQuestion` or `ExitPlanMode` | **Needs input** |
| `Notification` for a permission prompt | **Needs input** |
| `Notification` for plain idling ("waiting for your input" after about 60 s) | ignored — the column does not change |
| `Stop` | **Idle** |

Fallbacks:

1. **No events for the session** (it started before the hooks were installed):
   - interactive: `status: busy` → Working, `status: idle` → Idle
   - background: `state: blocked` → Needs input; any other `state` → Working
2. **Newest event is `Stop` but `status` is `busy`:** Working. This covers a missed event.

How to tell the two `Notification` kinds apart is decided from the real samples captured in step 0 of testing (section 8): by the notification type field if the Claude version sends one, otherwise by the message text.

### Tags

- **Repo tag:** if `cwd` is `~/dev/<repo>` or a folder inside it, the tag is `<repo>`.
- **Ticket:** look for the pattern `FIRE-\d+` in this order, and stop at the first match:
  1. `cwd`
  2. first prompt
  3. session name

  A match adds the tag `fireline` and stores the ticket key (for example `FIRE-97013`).
- **First prompt:** the `prompt` field of the first `UserPromptSubmit` event. If there is none, the first user message in the transcript `~/.claude/projects/*/<sessionId>.jsonl`.
- **Session name:** the first of: the name from `names.json`; the WezTerm tab title that Claude Code sets (status icon removed); the first prompt (first 60 characters); "New session". The `name` from `claude agents --json` (e.g. `gis-discover-monorepo-d7`) is not used.

### Lane

- `fireline` lane if a ticket was found. A fireline session shows **only** in this lane, never also in its repo lane.
- Otherwise the repo lane (`<repo>`).
- Otherwise the `other` lane.

Lane order: `fireline` first, then repo lanes sorted by name, then `other`.

### Card content

- Name (click to edit)
- Ticket key (if any), repo chip and git worktree name if the session runs in a linked worktree, otherwise the git branch (`git rev-parse`, read on each poll)
- Time in the current column (for example "4m")
- "not in WezTerm" badge when no WezTerm pane matches the session
- **Close** button, on Idle cards only

### Keeping `events.jsonl` small

At start, Session Slayer rewrites `events.jsonl` and keeps only the lines whose `session_id` is in the current `claude agents --json` output.

## 6. Page layout

```
[+ New session]   Tags: (all) (fireline) (GIS-discover-monorepo) (GIS-microservices)
Lanes: [on|off]

             | Working        | Needs input    | Idle
-------------+----------------+----------------+----------------
fireline     | [FIRE-97013]   |                |
             |  GIS-disc… 2m  |                |
-------------+----------------+----------------+----------------
GIS-discover-|                | [wiki docs]    | [GIS-6786]
 monorepo    |                |  permission    |  [Close]
-------------+----------------+----------------+----------------
```

- **Filter chips:** click a chip to show only cards with that tag. Click "all" to clear the filter.
- **Lanes on/off:** off shows one flat board with the three columns.
- **Banners** at the top for errors (section 7).
- The chosen filter and lane switch are kept in `localStorage`.

## 7. Actions

### Click a card → jump to the session

1. Get the session's terminal device: `ps -o tty= -p <pid>` (for example `ttys003`).
2. Find the pane with the same `tty_name` in `wezterm cli list --format json`.
3. Run `wezterm cli activate-pane --pane-id <N>`, then `open -a WezTerm`.
4. If no pane is found:
   - interactive session: show a message with the terminal device; the card already has the "not in WezTerm" badge.
   - background session: open a new WezTerm tab attached to it. The attach command is confirmed during build; if Claude has no direct attach command, the tab runs `claude agents`.

### Close (Idle cards only)

- In WezTerm: `wezterm cli kill-pane --pane-id <N>`.
- Not in WezTerm: send SIGTERM to the `pid`.
- No confirm step. A Idle session is idle and can be brought back with `claude --resume <sessionId>`.

### Rename

- Click the name on the card, type, press Enter or click outside to save.
- Stored in `names.json`. Not sent to Claude.

### New session

1. Dialog: repo dropdown (folders in `~/dev`), optional name, **Start**.
2. If WezTerm is not running: `open -a WezTerm` and wait until `wezterm cli list` answers (up to 10 seconds).
3. Run `wezterm cli spawn --cwd <repo> -- zsh -lic 'claude -n <name>; exec zsh'`. The login shell loads the normal setup (PATH, `rtk`, nvm). If Claude exits, a shell stays open in the tab.
4. Focus the new pane. The card shows up on the next poll.
5. Without a name, `-n` is left out and Claude picks its own name.

### HTTP API

| Method and path | Job |
|---|---|
| `GET /api/board` | The full board as JSON |
| `GET /api/stream` | SSE: sends the board again each time it changes |
| `GET /api/repos` | Folder names in `~/dev` |
| `POST /api/sessions` | New session. Body: `{ repo, name? }` |
| `POST /api/sessions/:sessionId/focus` | Jump to the session |
| `POST /api/sessions/:sessionId/close` | Close the session (only when its column is Idle; otherwise HTTP 409) |
| `PUT /api/sessions/:sessionId/name` | Rename. Body: `{ name }`. An empty name removes the stored name. |

### Errors

| Problem | What the user sees |
|---|---|
| `claude agents --json` fails or returns bad JSON | The board keeps the last good data. Red banner: "can't read sessions". |
| `wezterm` not installed | Banner. Jump and New session are greyed out. The board still works. |
| A bad line in `events.jsonl` | The line is skipped and logged in the server output. |
| Session Slayer not running | Hooks still write to the file. Nothing is lost. |
| A `wezterm cli` command fails | A short error message on the page, with the command's error text. |

### Safety

- The server listens on `127.0.0.1` only.
- Commands run through `execFile` with arguments passed one by one, never as one built-up shell string.
- The only shell string is the `zsh -lic` command for a new session. The name in it is shell-quoted, so a name like `foo; rm -rf ~` stays plain text.
- `repo` in `POST /api/sessions` must be one of the folders returned by `GET /api/repos`.

## 8. Testing

### Step 0: capture real samples (before writing code)

Install the hook and save real lines and outputs as test fixtures (saved sample inputs) in `test/fixtures/`:

- hook events: prompt, tool use, permission prompt, `AskUserQuestion`, `Stop`, the 60-second idle `Notification`, `SessionEnd`
- `claude agents --json` with interactive and background sessions
- `wezterm cli list --format json`

### Automated tests (Vitest, no network, no real WezTerm)

| File | What is tested |
|---|---|
| `tags.ts` | Ticket order `cwd` → first prompt → name; `~/dev/<repo>` match; `other`; no ticket |
| `board.ts` | Table test for every column rule and fallback; `Stop` but `busy`; idle `Notification` ignored; lane order |
| `hookEvents.ts` | Reads only new lines; skips bad lines; compacts the file at start |
| `installHooks.ts` | On a copy of the real `settings.json`: adds entries, keeps `rtk` and `herdr`, no duplicates on a second run, writes the backup |
| `wezterm.ts` | With a fake command runner: exact commands and arguments for focus, kill and spawn, including a name with quotes and `;` |
| `server.ts` | API with fake sources: board JSON, focus / close / rename / new routes, 409 on closing a non-Idle session, error banners |

### Manual check before version 1 is done

With 3 real sessions in WezTerm:

- [ ] New session from the board opens a tab and the card shows up in **Working**.
- [ ] A permission prompt moves the card to **Needs input**. Approving moves it back to **Working**.
- [ ] Turn ends → **Idle**. After 2 minutes of idling it is **still Idle**.
- [ ] A click jumps to the right tab, also with 2 WezTerm windows open.
- [ ] A session in a `FIRE-…` folder, or with a `FIRE-…` first prompt, lands in the **fireline** lane.
- [ ] A rename survives a restart of Session Slayer.
- [ ] Close removes the card and the pane. `/exit` in the terminal also removes the card.
- [ ] A session in Warp shows the "not in WezTerm" badge.

## 9. opencode (v2)

opencode v2 runs one background service per user. Its address and password are in `~/.local/state/opencode/service.json`. No plugin is needed. `src/sources/opencode.ts` reads it on every poll:

- **Windows:** running `opencode` processes, without the `opencode serve --service` process. Their folder comes from `lsof -d cwd`.
- **Sessions:** `GET /api/session` (newest 200). Each window gets the top-level session (no `parentID`) in its folder with the newest `time.updated` or `time.viewed`. One session per window.
- **Column:** pending items in `GET /api/session/{id}/permission` or `GET /api/session/{id}/form` mean **Needs input**. A session in `GET /api/session/active` means **Working**. Otherwise **Idle**.
- **Name:** the session `title` (counts as a title in the name order). Your rename still wins.
- **Jump, Close, branch, lanes:** the same as Claude, by `pid`.
- **Move to WezTerm:** `opencode -s <sessionId>`.
- **New session:** the dialog has a Claude Code / opencode switch. opencode has no name option, so the name field is hidden.
- **Limits:** two windows in the same folder are matched by recency, so they can swap. A permission asked by a subagent (a child session) is not seen.
