import type { Runner } from '../run';
import type { LiveSession } from '../types';
import type { EventStore, HookSession } from './hookEvents';
import { listWindows, type OcWindow } from './opencode';

// Codex has no live session list. Sessions are known from its hook events
// (see installCodexHooks); a session is live while a `codex` window runs in its folder.
// Each window shows the session in its folder with the newest event.
export function pickCodexSessions(windows: OcWindow[], sessions: HookSession[]): { window: OcWindow; session: HookSession }[] {
  const taken = new Set<string>();
  const out: { window: OcWindow; session: HookSession }[] = [];
  for (const w of windows) {
    const s = sessions.filter((x) => x.cwd === w.cwd && !taken.has(x.sessionId)).sort((a, b) => b.lastTs - a.lastTs)[0];
    if (!s) continue;
    taken.add(s.sessionId);
    out.push({ window: w, session: s });
  }
  return out;
}

// Claude sessions started with a prompt argument (`claude '<prompt>'`) are missing from
// `claude agents`; find them like Codex: running `claude` windows plus hook events.
export async function listUnlistedClaude(run: Runner, events: EventStore, listed: LiveSession[]): Promise<LiveSession[]> {
  const pids = new Set(listed.map((s) => s.pid));
  const ids = new Set(listed.map((s) => s.sessionId));
  const windows = (await listWindows(run, 'claude', /^\s*(?:(?:agents|doctor|update)(?:\s+-\S+)*\s*$|mcp\s+(?:serve|list|add|add-json|add-from-claude-desktop|remove|get|reset-project-choices)\b)/)).filter((w) => !pids.has(w.pid));
  if (!windows.length) return [];
  const out: LiveSession[] = [];
  const rest: OcWindow[] = [];
  // `claude --resume <id>` names its session. Such a session can carry a SessionEnd from
  // before the resume, so start it just after that end, or the board hides it.
  for (const w of windows) {
    const id = w.args?.match(/(?:^|\s)(?:--resume|-r)[\s=]+["']?([0-9a-f-]{36})/)?.[1];
    if (!id) rest.push(w);
    else if (!ids.has(id)) {
      ids.add(id);
      const endTs = events.ended.get(id);
      out.push({ tool: 'claude', sessionId: id, pid: w.pid, cwd: w.cwd, kind: 'interactive', startedAt: endTs === undefined ? undefined : endTs + 1 });
    }
  }
  if (!rest.length) return out;
  const sessions = events.hookSessions('claude').filter((s) => !ids.has(s.sessionId));
  return [
    ...out,
    ...pickCodexSessions(rest, sessions).map(({ window, session }) => ({
      tool: 'claude' as const,
      sessionId: session.sessionId,
      pid: window.pid,
      cwd: window.cwd,
      kind: 'interactive' as const,
      startedAt: session.startedAt,
    })),
  ];
}

export async function listCodexSessions(run: Runner, events: EventStore): Promise<LiveSession[]> {
  const windows = await listWindows(run, 'codex', /^\s*(?:(?:app-server|mcp-server)(?:\s+-\S+)*\s*$|mcp\s+(?:serve|list|add|remove|get|login|logout)\b)/);
  return pickCodexSessions(windows, events.hookSessions('codex')).map(({ window, session }) => ({
    tool: 'codex',
    sessionId: session.sessionId,
    pid: window.pid,
    cwd: window.cwd,
    kind: 'interactive',
    startedAt: session.startedAt,
    model: session.model,
  }));
}
