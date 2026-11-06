# Session Slayer setup

Run once per machine. Safe to run again. Explain each step in plain words and ask before any install or file change.

## 1. Check the tools

| Check | If missing |
|---|---|
| macOS (`uname`) | Stop: the board needs macOS (`ps`, `lsof`, `open -a`). |
| `node -v` is 26 or later (current LTS) | Ask the user to install Node 26 (e.g. `brew install node@26`, or `nvm install` in `<SKILL_DIR>/app`, which reads `.nvmrc`). |
| `pnpm -v` | Offer `npm install -g pnpm` (or `corepack enable`). |
| `which wezterm` | Offer `brew install --cask wezterm`. |
| `which claude opencode codex` | Note which exist. At least one is needed. opencode must be v2 or later. |

## 2. Ask for the projects folder

Ask which folder holds the git repos. Suggest `~/dev` if it exists.

Check it exists and list the repos in it (sub-folders with a `.git` folder). Show the list. The board uses this folder for repo lanes and the **+ New session** picker.

## 3. Install the app and the hooks

```bash
cd <SKILL_DIR>/app && pnpm install && pnpm slayer init --projects-dir <folder>
```

`init` does two things:

- Saves the folder to `~/.session-slayer/config.json`.
- Installs the hooks (same as `pnpm slayer install-hooks`):
  - Claude Code: adds hook entries and a status line wrapper to `~/.claude/settings.json`. Backup: `settings.json.session-slayer.bak`. Your own status line still runs.
  - Codex (only when installed): adds hooks to `~/.codex/hooks.json`, with a backup. Tell the user Codex asks once to approve them.
  - opencode: nothing to install.

The hooks only append one line per event to `~/.session-slayer/events.jsonl`. To undo: `pnpm slayer uninstall-hooks` (removes only the Session Slayer entries).

Check: `grep -c session-slayer ~/.claude/settings.json` is more than 0. Claude Code sessions started before this need a restart to send events.

## 4. WezTerm (optional)

- Check `wezterm cli list` works from a WezTerm tab.
- Offer a config. Ask which theme:

| Theme | File | What it sets |
|---|---|---|
| Catppuccin (default) | `<SKILL_DIR>/wezterm/catppuccin.lua` | Catppuccin colors that follow macOS light / dark, JetBrains Mono 13 (ships with WezTerm), padding, bigger window, tab bar, large scrollback, no bell. Keys: Cmd/Option + arrows move in the line, Shift+Enter new line in Claude Code, Cmd+D split. |
| Solarized | `<SKILL_DIR>/wezterm/solarized.lua` | Solarized Dark, Monaco for Powerline 20 without ligatures (Menlo if not installed). Keys: Cmd+Shift+Left/Right move the tab, Cmd+V pastes an image into Claude Code, Cmd+C copies a Claude Code selection. |
| WezTerm defaults | `<SKILL_DIR>/wezterm/empty.lua` | Nothing: WezTerm's own built-in look and keys. A clean file to start your own config from. |

All three keep WezTerm's own warnings before closing a tab or window with a running session.

- If `~/.wezterm.lua` (or `~/.config/wezterm/wezterm.lua`) already exists, do not replace it. Show the user the differences and ask. On yes, first keep a copy: `cp ~/.wezterm.lua ~/.wezterm.lua.session-slayer.bak`.
- On yes: `cp <SKILL_DIR>/wezterm/<theme>.lua ~/.wezterm.lua`. WezTerm reloads it by itself.
- Check it loads: `wezterm --config-file ~/.wezterm.lua show-keys >/dev/null` prints no error.

Tell the user: start sessions in WezTerm (or with the board's **+ New session**) so the board can jump to them.

## 5. Start the board

Follow **Board** in `SKILL.md`. Give the user the URL.

## 6. Start at login (offer it)

The board already keeps running after the session that started it ends, but not after a reboot or a crash. Ask: "Start the board at login and restart it if it stops?"

On yes, write a launchd agent `~/Library/LaunchAgents/com.session-slayer.plist` that runs `pnpm serve` (foreground: launchd must own the process, so not `pnpm start`) in `<SKILL_DIR>/app`, with `RunAtLoad` and `KeepAlive` set to true. launchd does not load the shell profile: put the folder of Node 26 first in the plist `PATH` (e.g. `~/.nvm/versions/node/v26.x.y/bin`, from `nvm which 26`). Show the file before writing it and load it with `launchctl load <file>` only on yes. If a board already runs, stop it first (`kill <pid>` from `~/.session-slayer/instance.json`).
