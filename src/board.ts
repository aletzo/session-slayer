import { tagsFor } from './tags';
import type { Card, Column, LiveSession, SessionEvent } from './types';

export type GitInfo = { branch?: string; worktree?: string };

// Output of `git rev-parse --abbrev-ref HEAD --show-toplevel --git-dir --git-common-dir`, one per line.
// A linked worktree has its own git dir, different from the common one; its name is its folder name.
export function parseGitInfo(out: string): GitInfo {
  const [head, top, gitDir, commonDir] = out.trim().split('\n');
  return {
    branch: head && head !== 'HEAD' ? head : undefined,
    worktree: gitDir && commonDir && gitDir !== commonDir ? top?.split('/').pop() : undefined,
  };
}

const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// The newest relevant event decides the column; null means "no opinion" (idle notifications).
export function columnFromEvent(e: SessionEvent): Column | null {
  switch (e.event) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'working';
    case 'PreToolUse':
      return e.toolName && ASKING_TOOLS.has(e.toolName) ? 'needs_input' : 'working';
    case 'Notification':
      return e.notificationKind === 'permission' ? 'needs_input' : null;
    case 'PermissionRequest': // Codex
      return 'needs_input';
    case 'Stop':
    case 'Interrupt': // Codex
      return 'idle';
    default:
      return null;
  }
}

export function columnFor(s: LiveSession, last: SessionEvent | undefined): Column {
  // opencode state comes from its service, not from hook events
  if (s.tool === 'opencode') return s.state === 'blocked' ? 'needs_input' : s.status === 'busy' ? 'working' : 'idle';
  const fromEvent = last && columnFromEvent(last);
  if (!fromEvent) {
    if (s.kind === 'background') return s.state === 'blocked' ? 'needs_input' : 'working';
    return s.status === 'busy' ? 'working' : 'idle';
  }
  if (fromEvent === 'idle' && s.status === 'busy') return 'working';
  return fromEvent;
}

export type BoardInput = {
  sessions: LiveSession[];
  lastEvent: (id: string) => SessionEvent | undefined;
  firstPrompt: (id: string) => string | undefined;
  names: Record<string, string>;
  weztermSessions: Set<string>;
  branches: Map<string, GitInfo>; // cwd -> git branch / worktree
  titles: Map<string, string>; // sessionId -> Claude tab title
  since: Map<string, { column: Column; since: number }>;
  eventSince?: (id: string) => { column: Column; since: number } | undefined; // from stored hook events
  now: number;
  home: string;
};

// Pure: also updates `since` so the caller can keep it between ticks.
export function buildCards(input: BoardInput): Card[] {
  const live = new Set(input.sessions.map((s) => s.sessionId));
  for (const id of input.since.keys()) if (!live.has(id)) input.since.delete(id);

  return input.sessions.map((s) => {
    const column = columnFor(s, input.lastEvent(s.sessionId));
    // Prefer times from the data (they survive restarts); fall back to when this server first saw the column.
    const ev = input.eventSince?.(s.sessionId);
    const prev = input.since.get(s.sessionId);
    const columnSince =
      ev?.column === column ? ev.since : s.columnSince !== undefined ? s.columnSince : prev?.column === column ? prev.since : input.now;
    input.since.set(s.sessionId, { column, since: columnSince });

    // Claude's own names ("my-repo-d7") say nothing, so they are not used.
    const firstPrompt = input.firstPrompt(s.sessionId);
    const user = input.names[s.sessionId];
    const title = input.titles.get(s.sessionId);
    const [name, nameSource]: [string, Card['nameSource']] = user
      ? [user, 'user']
      : title
        ? [title, 'title']
        : firstPrompt
          ? [firstPrompt.slice(0, 60), 'prompt']
          : ['New session', 'none'];
    const t = tagsFor(s.cwd, firstPrompt, name, input.home);
    return {
      sessionId: s.sessionId,
      name,
      nameSource,
      column,
      lane: t.lane,
      laneKind: t.laneKind,
      repo: t.repo,
      branch: input.branches.get(s.cwd)?.branch,
      worktree: input.branches.get(s.cwd)?.worktree,
      ticket: t.ticket,
      tags: t.tags,
      firstPrompt,
      columnSince,
      kind: s.kind,
      tool: s.tool,
      cwd: s.cwd,
      inWezterm: input.weztermSessions.has(s.sessionId),
    };
  });
}
