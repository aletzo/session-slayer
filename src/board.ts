import { tagsFor } from './tags';
import type { Card, Column, LiveSession, SessionEvent } from './types';

const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// The newest relevant event decides the column; null means "no opinion" (idle notifications).
function columnFromEvent(e: SessionEvent): Column | null {
  switch (e.event) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'working';
    case 'PreToolUse':
      return e.toolName && ASKING_TOOLS.has(e.toolName) ? 'needs_input' : 'working';
    case 'Notification':
      return e.notificationKind === 'permission' ? 'needs_input' : null;
    case 'Stop':
      return 'idle';
    default:
      return null;
  }
}

export function columnFor(s: LiveSession, last: SessionEvent | undefined): Column {
  const fromEvent = last && columnFromEvent(last);
  if (!fromEvent) {
    if (s.kind === 'background') return s.state === 'blocked' ? 'needs_input' : 'working';
    return s.status === 'busy' ? 'working' : 'idle';
  }
  if (fromEvent === 'idle' && s.status === 'busy') return 'working';
  return fromEvent;
}

export function isRelevant(e: SessionEvent): boolean {
  return columnFromEvent(e) !== null;
}

export type BoardInput = {
  sessions: LiveSession[];
  lastEvent: (id: string) => SessionEvent | undefined;
  firstPrompt: (id: string) => string | undefined;
  names: Record<string, string>;
  weztermSessions: Set<string>;
  since: Map<string, { column: Column; since: number }>;
  now: number;
  home: string;
};

// Pure: also updates `since` so the caller can keep it between ticks.
export function buildCards(input: BoardInput): Card[] {
  const live = new Set(input.sessions.map((s) => s.sessionId));
  for (const id of input.since.keys()) if (!live.has(id)) input.since.delete(id);

  return input.sessions.map((s) => {
    const column = columnFor(s, input.lastEvent(s.sessionId));
    const prev = input.since.get(s.sessionId);
    const columnSince = prev?.column === column ? prev.since : input.now;
    input.since.set(s.sessionId, { column, since: columnSince });

    const name = input.names[s.sessionId] || s.name || s.sessionId.slice(0, 8);
    const firstPrompt = input.firstPrompt(s.sessionId);
    const t = tagsFor(s.cwd, firstPrompt, name, input.home);
    return {
      sessionId: s.sessionId,
      name,
      column,
      lane: t.lane,
      repo: t.repo,
      ticket: t.ticket,
      tags: t.tags,
      firstPrompt,
      columnSince,
      kind: s.kind,
      cwd: s.cwd,
      inWezterm: input.weztermSessions.has(s.sessionId),
    };
  });
}
