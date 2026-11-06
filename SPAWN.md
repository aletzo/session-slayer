# Spawn sessions

A spawned session is a real, separate Claude Code session in a new WezTerm tab. The user can see it and talk to it. It is NOT a subagent. This works: do not say it can't be done. Spawned sessions show up on the board by themselves.

## One session

1. Pick the folder. For work on a new branch, first create a git worktree (ask before git commands), and use its path.
2. Write a self-contained prompt. The new session knows nothing about this chat: give it the goal, branch, commit, files, and the rules the user follows (what needs approval, which GitHub user the repo uses).
3. Spawn it:

```bash
# Quoted heredoc: quotes, backticks and $ in the prompt stay plain text.
P=$(cat <<'SLAYER_PROMPT_EOF'
<prompt>
SLAYER_PROMPT_EOF
)
wezterm cli spawn --cwd <absolute folder> -- env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDECODE SLAYER_PROMPT="$P" "$SHELL" -lic 'claude "$SLAYER_PROMPT"; exec "$SHELL"'
```

The command prints the new pane id. The prompt goes in an environment variable, not `$1`, so it works in any login shell (fish too). `exec "$SHELL"` keeps the tab open after Claude exits.

4. Tell the user in one line: the folder, the pane id, and what the session will do.

## Batch

One session per item.

### 1. Read the list

- Split on spaces, commas or new lines. Drop duplicates.
- An item like `ABC-123` is a ticket key. Anything else is a free-text task.
- Unclear -> ask once. Show the parsed list and the folder before spawning more than 5.

### 2. Pick folder and prompt

- Folder: the repo the user names, inside the projects folder from `~/.session-slayer/config.json` (`projectsDir`); else the current folder.
- Prompt for a ticket: `Work on ticket <KEY>. Read the ticket first.` Prompt for a task: the task text.
- Every prompt must be self-contained. Append:
  - the user's extra instructions, if any;
  - `Before any edit, create your own git worktree and branch; other sessions share this clone. Ask before every git command, commit, push or other write outside this folder.`

### 3. Spawn

```bash
DIR=<absolute folder>
# One block per item. Never put prompt text inside "..." or '...': use a quoted heredoc.
P=$(cat <<'SLAYER_PROMPT_EOF'
<prompt for item 1>
SLAYER_PROMPT_EOF
)
wezterm cli spawn --cwd "$DIR" -- env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDECODE SLAYER_PROMPT="$P" "$SHELL" -lic 'claude "$SLAYER_PROMPT"; exec "$SHELL"'
# ...repeat for each item
```

Each call prints a pane id. Name tabs with `wezterm cli set-tab-title --pane-id <id> <item>`. A ticket key in the tab title also puts the card in that ticket's lane on the board.

### 4. Report

One table: item, pane id, folder. Nothing else.

## Do not

- Use the Agent tool, Terminal.app or `osascript` (macOS blocks Apple events to Terminal).
- Spawn when `wezterm` is missing (`which wezterm`). Then print the commands for the user to run.
- Let two sessions edit the same checkout: each makes its own worktree.
