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
  const windows = (await listWindows(run, 'claude', /^\s*(agents|mcp|doctor|update)\b/)).filter((w) => !pids.has(w.pid));
  if (!windows.length) return [];
  const sessions = events.hookSessions('claude').filter((s) => !ids.has(s.sessionId));
  return pickCodexSessions(windows, sessions).map(({ window, session }) => ({
    tool: 'claude',
    sessionId: session.sessionId,
    pid: window.pid,
    cwd: window.cwd,
    kind: 'interactive',
    startedAt: session.startedAt,
  }));
}

export async function listCodexSessions(run: Runner, events: EventStore): Promise<LiveSession[]> {
  const windows = await listWindows(run, 'codex', /\b(app-server|mcp-server|mcp)\b/);
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
