import type { Runner } from '../run';
import type { LiveSession } from '../types';

type Raw = {
  id?: string;
  sessionId: string;
  pid?: number;
  cwd: string;
  name?: string;
  kind: 'interactive' | 'background';
  startedAt?: number;
  status?: string;
  state?: string;
};

export function parseAgents(json: string): LiveSession[] {
  const raw = JSON.parse(json) as Raw[];
  if (!Array.isArray(raw)) throw new Error('claude agents --json did not return an array');
  return raw.map((r) => ({
    tool: 'claude',
    sessionId: r.sessionId,
    pid: r.pid,
    cwd: r.cwd,
    name: r.name,
    kind: r.kind,
    startedAt: r.startedAt,
    status: r.status,
    state: r.state,
  }));
}

export async function listClaudeSessions(run: Runner): Promise<LiveSession[]> {
  return parseAgents(await run('claude', ['agents', '--json']));
}
