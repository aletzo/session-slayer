import type { Runner } from '../run';
import type { LiveSession } from '../types';
import type { EventStore, HookSession } from './hookEvents';
import { PIN_MARGIN, listWindows, type OcWindow } from './opencode';

// First line of a session's first prompt (UserPromptSubmit hook events): a window spawned with
// `claude '<prompt>'` or `codex '<prompt>'` submits the prompt as its first message.
const promptLineOf = (events: EventStore) => (id: string) => events.firstPrompt(id)?.split('\n')[0].trimEnd();

// First line of the ps args (ps joins argv with spaces and escapes newline characters as
// \012): for a spawned `claude '<prompt>'` / `codex '<prompt>'` window the args begin with the
// prompt, so its first line must equal a session's first prompt line for a pin - a session
// whose prompt merely occurs somewhere inside the args must never match.
function argsFirstLine(args: string | undefined): string | undefined {
  return args?.split(/\n|\\012/, 1)[0].trimEnd() || undefined;
}

// Codex has no live session list. Sessions are known from its hook events
// (see installCodexHooks); a session is live while a `codex` window runs in its folder.
// Pure: pair each window to the session it actually runs.
// 1. Pins first, in one pass over every window and before any fallback (ps order is
//    arbitrary): a window whose args begin with a session's first prompt line pins to the
//    session born closest to the window start - the newest when several share the line. The
//    pin is exact only when that session is the single match and no sibling window in the
//    folder carries the same prompt: identical batch prompts cannot be told apart.
// 2. The rest fall back to the newest-event session in the folder: a guess, since a closed
//    window's newer session can steal the pair.
// 3. Launch args only name the session the process started with: when a newer session in the
//    folder started after the window did, is unclaimed and more recently active, the user may
//    have switched inside the TUI - the pair stays but is marked guessed, so send keeps
//    refusing on it.
export function pickCodexSessions(
  windows: OcWindow[],
  sessions: HookSession[],
  firstLine: (sessionId: string) => string | undefined = () => undefined,
): { window: OcWindow; session: HookSession; guessed: boolean }[] {
  const taken = new Set<string>();
  const pairOf = new Map<OcWindow, { session: HookSession; exact: boolean }>();
  for (const w of windows) {
    const line = argsFirstLine(w.args);
    if (!line) continue;
    const matches = sessions.filter((x) => !taken.has(x.sessionId) && x.cwd === w.cwd && (firstLine(x.sessionId) ?? '').trimEnd() === line);
    const s = matches.sort((a, b) =>
      w.startedAt === undefined ? b.lastTs - a.lastTs : Math.abs(a.startedAt - w.startedAt) - Math.abs(b.startedAt - w.startedAt) || b.lastTs - a.lastTs,
    )[0];
    if (!s) continue;
    const twin = windows.some((o) => o !== w && o.cwd === w.cwd && argsFirstLine(o.args) === line);
    pairOf.set(w, { session: s, exact: matches.length === 1 && !twin });
    taken.add(s.sessionId);
  }
  for (const w of windows) {
    if (pairOf.has(w)) continue;
    const s = sessions.filter((x) => !taken.has(x.sessionId) && x.cwd === w.cwd).sort((a, b) => b.lastTs - a.lastTs)[0];
    if (!s) continue;
    pairOf.set(w, { session: s, exact: false });
    taken.add(s.sessionId);
  }
  return windows
    .filter((w) => pairOf.has(w))
    .map((w) => {
      const { session, exact } = pairOf.get(w)!;
      const switched =
        exact &&
        w.startedAt !== undefined &&
        sessions.some((y) => !taken.has(y.sessionId) && y.cwd === w.cwd && y.startedAt > w.startedAt! + PIN_MARGIN && y.lastTs > session.lastTs);
      return { window: w, session, guessed: !exact || switched };
    });
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
    ...pickCodexSessions(rest, sessions, promptLineOf(events)).map(({ window, session, guessed }) => ({
      tool: 'claude' as const,
      sessionId: session.sessionId,
      pid: window.pid,
      cwd: window.cwd,
      kind: 'interactive' as const,
      startedAt: session.startedAt,
      windowGuessed: guessed,
    })),
  ];
}

export async function listCodexSessions(run: Runner, events: EventStore): Promise<LiveSession[]> {
  const windows = await listWindows(run, 'codex', /^\s*(?:(?:app-server|mcp-server)(?:\s+-\S+)*\s*$|mcp\s+(?:serve|list|add|remove|get|login|logout)\b)/);
  const sessions = events.hookSessions('codex');
  const out: LiveSession[] = [];
  const rest: OcWindow[] = [];
  const seen = new Set<string>();
  // `codex resume <id>` names its session (board restore and move spawn this). A session that
  // carried a SessionEnd starts just after it, or the board hides the resume (see board()).
  for (const w of windows) {
    const id = w.args?.match(/(?:^|\s)resume[\s=]+["']?([0-9a-f-]{36})/)?.[1];
    if (!id) rest.push(w);
    else if (!seen.has(id)) {
      seen.add(id);
      const endTs = events.ended.get(id);
      const s = sessions.find((x) => x.sessionId === id);
      out.push({ tool: 'codex', sessionId: id, pid: w.pid, cwd: w.cwd, kind: 'interactive', startedAt: endTs === undefined ? s?.startedAt : endTs + 1, model: s?.model });
    }
  }
  if (!rest.length) return out;
  return [
    ...out,
    ...pickCodexSessions(rest, sessions.filter((x) => !seen.has(x.sessionId)), promptLineOf(events)).map(({ window, session, guessed }) => ({
      tool: 'codex' as const,
      sessionId: session.sessionId,
      pid: window.pid,
      cwd: window.cwd,
      kind: 'interactive' as const,
      startedAt: session.startedAt,
      model: session.model,
      windowGuessed: guessed,
    })),
  ];
}
