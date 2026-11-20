import type { Runner } from '../run';
import type { LiveSession } from '../types';
import type { EventStore, HookSession } from './hookEvents';

export type PiProcess = { start: number; args: string };

// A pid alone is not proof: after a crash (no session_shutdown) the OS can give the pid to another
// program. A process counts as the session's only if it runs pi and started before the session's first event.
const SLACK_MS = 5_000; // ps start times have 1 s steps; the first event comes right after start
const isPi = (args: string) => /(^|[\s/])pi(\s|$)/.test(args);

// Pure: pi sessions whose own pi process still runs. One per process: after /new or /resume the
// same process writes a new session id, so the session with the newest event wins.
export function livePiSessions(sessions: HookSession[], procs: Map<number, PiProcess>): LiveSession[] {
  const byPid = new Map<number, HookSession>();
  for (const s of sessions) {
    const p = s.pid ? procs.get(s.pid) : undefined;
    if (!p || !s.cwd || !isPi(p.args) || p.start > s.startedAt + SLACK_MS) continue;
    const prev = byPid.get(s.pid!);
    if (!prev || s.lastTs > prev.lastTs) byPid.set(s.pid!, s);
  }
  return [...byPid.values()].map((s) => ({
    tool: 'pi',
    sessionId: s.sessionId,
    pid: s.pid,
    cwd: s.cwd!,
    kind: 'interactive',
    startedAt: s.startedAt,
    model: s.model,
  }));
}

// `ps -o pid=,lstart=,args=` lines: "123 Fri Nov 20 11:23:42 2026 node /x/bin/pi".
export function parsePs(out: string): Map<number, PiProcess> {
  const procs = new Map<number, PiProcess>();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    const start = m ? Date.parse(m[2]) : NaN;
    if (m && !Number.isNaN(start)) procs.set(Number(m[1]), { start, args: m[3] });
  }
  return procs;
}

export async function listPiSessions(run: Runner, events: EventStore): Promise<LiveSession[]> {
  const sessions = events.hookSessions('pi');
  const pids = [...new Set(sessions.map((s) => s.pid).filter((p): p is number => !!p))];
  if (!pids.length) return [];
  let out = '';
  try {
    out = await run('ps', ['-o', 'pid=,lstart=,args=', '-p', pids.join(',')]);
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? ''; // ps exits 1 when some pids are gone
  }
  return livePiSessions(sessions, parsePs(out));
}
