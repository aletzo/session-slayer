import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runner } from '../run';
import type { LiveSession, Reply } from '../types';
import { shortReply } from './hookEvents';
import { type Ledger, ledgerSpend, readLedger, type Spend, writeLedger } from '../spend';

// opencode v2 runs one background service per user; its address and password are in service.json.
const SERVICE_FILE = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'opencode', 'service.json');

type Service = { url: string; password: string };
export type OcSession = {
  id: string;
  cost?: number;
  model?: { id?: string };
  parentID?: string;
  title?: string;
  time: { created: number; updated: number; viewed?: number; idle?: number };
  location: { directory: string };
};
export type OcWindow = { pid: number; cwd: string; args?: string };

function readService(file = SERVICE_FILE): Service | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined; // opencode v2 not installed or never started
  }
}

async function api<T>(svc: Service, p: string, body?: unknown): Promise<T> {
  const res = await fetch(svc.url + p, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${svc.password}`).toString('base64')}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`opencode ${p}: HTTP ${res.status}`);
  return ((await res.json()) as { data: T }).data;
}

// Running terminal windows of `bin` (not its background processes) and their folders.
// `notWindow` sees all args joined (ps has no argv split), prompt text included: match whole subcommand shapes only.
export async function listWindows(run: Runner, bin = 'opencode', notWindow = /^\s*serve(\s+-\S+)*\s*$/): Promise<OcWindow[]> {
  const ps = await run('ps', ['-axo', 'pid=,args=']);
  const args = new Map(
    ps
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(\S+)(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m && path.basename(m[2]) === bin && !notWindow.test(m[3]))
      .map((m) => [Number(m[1]), m[3].trim()] as const),
  );
  const pids = [...args.keys()];
  if (!pids.length) return [];
  let out = '';
  try {
    out = await run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]);
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '';
  }
  const windows: OcWindow[] = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) windows.push({ pid, cwd: line.slice(1), args: args.get(pid) });
  }
  return windows;
}

// Pure: each window shows the top-level session in its folder that was used most recently.
export function pickSessions(windows: OcWindow[], sessions: OcSession[]): { window: OcWindow; session: OcSession }[] {
  const taken = new Set<string>();
  const last = (s: OcSession) => Math.max(s.time.updated, s.time.viewed ?? 0);
  const out: { window: OcWindow; session: OcSession }[] = [];
  for (const w of windows) {
    const s = sessions
      .filter((x) => !x.parentID && x.location.directory === w.cwd && !taken.has(x.id))
      .sort((a, b) => last(b) - last(a))[0];
    if (!s) continue;
    taken.add(s.id);
    out.push({ window: w, session: s });
  }
  return out;
}

export type OcMessage = { type: string; time: { created: number; completed?: number }; content?: { type: string; text?: string }[] };

// Pure: text of the newest assistant message that has text (tool-only messages are skipped).
// Never throws: the message shape comes from opencode and is not checked, and a bad shape must only drop the reply.
export function lastAssistantReply(messages: unknown): Reply | undefined {
  if (!Array.isArray(messages)) return undefined;
  const created = (m: OcMessage) => m?.time?.created ?? 0;
  for (const m of [...(messages as OcMessage[])].sort((a, b) => created(b) - created(a))) {
    if (m?.type !== 'assistant' || !Array.isArray(m.content)) continue;
    const text = shortReply(m.content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join(' '));
    if (text) return { text, ts: m.time?.completed ?? created(m) };
  }
  return undefined;
}

export type OpencodeResult = { sessions: LiveSession[]; spend?: Spend };

// Cost of top-level sessions per period, split by the day it was spent. Mutates the ledger.
export function sessionSpend(sessions: OcSession[], ledger: Ledger = {}, now = Date.now()): Spend {
  const totals = sessions.filter((s) => !s.parentID).map((s) => ({ id: s.id, total: s.cost ?? 0, at: s.time.updated }));
  return ledgerSpend(ledger, totals, now);
}

export async function listOpencodeSessions(run: Runner, serviceFile?: string, ledgerFile?: string): Promise<OpencodeResult> {
  const svc = readService(serviceFile);
  if (!svc) return { sessions: [] };

  const [windows, sessions, active] = await Promise.all([
    listWindows(run),
    api<OcSession[]>(svc, '/api/session?limit=1000&order=desc'),
    api<Record<string, { type: string }>>(svc, '/api/session/active'),
  ]);

  const live = await Promise.all(
    pickSessions(windows, sessions).map(async ({ window, session }) => {
      const [perms, forms, messages] = await Promise.all([
        api<unknown[]>(svc, `/api/session/${session.id}/permission`).catch(() => []),
        api<unknown[]>(svc, `/api/session/${session.id}/form`).catch(() => []),
        api<OcMessage[]>(svc, `/api/session/${session.id}/message?limit=10`).catch(() => []),
      ]);
      const waiting = perms.length > 0 || forms.length > 0;
      return {
        tool: 'opencode' as const,
        sessionId: session.id,
        pid: window.pid,
        cwd: session.location.directory,
        name: session.title,
        kind: 'interactive' as const,
        startedAt: session.time.created,
        columnSince: !active[session.id] && !waiting ? (session.time.idle ?? session.time.updated) : undefined,
        costUsd: session.cost,
        model: session.model?.id?.split('/').pop(),
        status: active[session.id] ? 'busy' : 'idle',
        state: waiting ? 'blocked' : undefined,
        lastReply: lastAssistantReply(messages),
        windowGuessed: true,
      };
    }),
  );
  const ledger = readLedger(ledgerFile);
  const spend = sessionSpend(sessions, ledger);
  writeLedger(ledgerFile, ledger);
  return { sessions: live, spend };
}

// Creates an empty session with a title, so the new window can open it with `opencode -s <id>`.
export async function createOpencodeSession(directory: string, title: string, serviceFile?: string): Promise<string> {
  const svc = readService(serviceFile);
  if (!svc) throw new Error('opencode v2 service not found');
  return (await api<OcSession>(svc, '/api/session', { title, location: { directory } })).id;
}
