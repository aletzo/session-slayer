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
export type OcWindow = { pid: number; cwd: string; args?: string; startedAt?: number };

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
// etime gives each window's start time, so a pin can tell whether a newer session postdates it.
export async function listWindows(run: Runner, bin = 'opencode', notWindow = /^\s*serve(\s+-\S+)*\s*$/): Promise<OcWindow[]> {
  const ps = await run('ps', ['-axo', 'pid=,etime=,args=']);
  const args = new Map(
    ps
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(\S+)(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m && path.basename(m[3]) === bin && !notWindow.test(m[4]))
      .map((m) => [Number(m[1]), { args: m[4].trim(), startedAt: startedAtMs(m[2]) }] as const),
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
    else if (line.startsWith('n') && pid) {
      const a = args.get(pid);
      windows.push({ pid, cwd: line.slice(1), args: a?.args, startedAt: a?.startedAt });
    }
  }
  return windows;
}

// ps etime ("MM:SS" | "HH:MM:SS" | "dd-HH:MM:SS") -> when the process started, in ms.
function startedAtMs(etime: string, now = Date.now()): number | undefined {
  const m = etime.match(/^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?$/);
  if (!m) return undefined;
  const [d, a, b, c] = m.slice(1).map((x) => (x === undefined ? undefined : Number(x)));
  const [h, min, s] = c === undefined ? [0, a, b] : [a, b, c];
  return now - (((((d ?? 0) * 24 + (h ?? 0)) * 60 + (min ?? 0)) * 60 + (s ?? 0)) * 1000);
}

// Session id from the command line: the board spawns `opencode -s 'ses_x'`, users may write
// `--session ses_x` or `--session=ses_x`. Restricted to the `ses_` id shape, so prompt text
// that merely mentions a flag cannot pin a session.
export function argSessionId(args: string | undefined): string | undefined {
  return args?.match(/(?:^|\s)(?:--session|-s)(?:=|\s+)["']?(ses_\w+)/)?.[1];
}

// Recency of a session: last update, or last view.
const last = (s: OcSession) => Math.max(s.time.updated, s.time.viewed ?? 0);

// A session created this soon after a window started may be that window's own run, so it does
// not cast doubt on the window's pin.
export const PIN_MARGIN = 5000;

// First line of the `--prompt` value in opencode args (`--prompt <text> [directory]`): ps joins
// argv with spaces and escapes newline characters as \012, and the directory argument trails
// the text. A session pins only when this whole line equals its first message line - a session
// whose prompt merely occurs somewhere inside the args must never match.
export function argPromptLine(args: string | undefined, cwd: string): string | undefined {
  if (!args) return undefined;
  const eq = args.indexOf('--prompt=');
  const from = eq >= 0 ? eq : args.indexOf('--prompt ');
  if (from < 0) return undefined;
  let text = args.slice(from + (eq >= 0 ? '--prompt='.length : '--prompt '.length));
  const tail = ` ${cwd}`;
  if (text.endsWith(tail)) text = text.slice(0, -tail.length);
  return text.split(/\n|\\012/, 1)[0].trimEnd() || undefined;
}

// Pure: pair each window to the session it actually runs, not just to its folder.
// 1. Pins first, in one pass over every window and before any fallback (lsof order is
//    arbitrary: a plain window's fallback must not steal a session a later window would pin).
//    `-s <id>` on the command line pins the window to that session. A `--prompt <text>` run
//    writes the prompt as its first message, so the window pins to the session whose first
//    message line equals the prompt value's first line - the one born closest to the window
//    start, since respawning the same prompt leaves an older twin behind. The pin is exact
//    only when that session is the single match and no sibling window in the folder carries
//    the same prompt: identical batch prompts cannot be told apart, and a twin session (same
//    prompt, its window closed) makes even a single window's best pick a guess.
// 2. The rest fall back to the newest top-level session in the folder: a guess, since a closed
//    window's newer session can steal the pair here, which once hid a live session.
// 3. Launch args only name the session the process started with: when a newer session in the
//    folder was created after the window started, is unclaimed and more recently active, the
//    user may have switched inside the TUI - the pair stays but is marked guessed, so send
//    keeps refusing on it.
export function pickSessions(
  windows: OcWindow[],
  sessions: OcSession[],
  firstLine: (sessionId: string) => string | undefined = () => undefined,
): { window: OcWindow; session: OcSession; guessed: boolean }[] {
  const taken = new Set<string>();
  const free = (x: OcSession) => !x.parentID && !taken.has(x.id);
  const pairOf = new Map<OcWindow, { session: OcSession; exact: boolean }>();
  for (const w of windows) {
    const byId = argSessionId(w.args);
    const line = argPromptLine(w.args, w.cwd);
    const s = (byId && sessions.find((x) => x.id === byId && free(x))) ?? (line && promptMatch(w, line, sessions, free, firstLine));
    if (!s) continue;
    const matches = line ? sessions.filter((x) => free(x) && x.location.directory === w.cwd && (firstLine(x.id) ?? '').trimEnd() === line).length : 0;
    const twin = !!line && windows.some((o) => o !== w && o.cwd === w.cwd && argPromptLine(o.args, o.cwd) === line);
    pairOf.set(w, { session: s, exact: !line || (!twin && matches === 1) });
    taken.add(s.id);
  }
  for (const w of windows) {
    if (pairOf.has(w)) continue;
    const s = sessions.filter((x) => free(x) && x.location.directory === w.cwd).sort((a, b) => last(b) - last(a))[0];
    if (!s) continue;
    pairOf.set(w, { session: s, exact: false });
    taken.add(s.id);
  }
  return windows
    .filter((w) => pairOf.has(w))
    .map((w) => {
      const { session, exact } = pairOf.get(w)!;
      const switched =
        exact &&
        w.startedAt !== undefined &&
        sessions.some(
          (y) => !taken.has(y.id) && !y.parentID && y.location.directory === w.cwd && y.time.created > w.startedAt! + PIN_MARGIN && last(y) > last(session),
        );
      return { window: w, session, guessed: !exact || switched };
    });
}

// Among sessions whose first message line equals the prompt, the one born closest to the
// window start is the window's own run; newest wins when the start time is unknown.
function promptMatch(
  w: OcWindow,
  line: string,
  sessions: OcSession[],
  free: (x: OcSession) => boolean,
  firstLine: (sessionId: string) => string | undefined,
): OcSession | undefined {
  return sessions
    .filter((x) => free(x) && x.location.directory === w.cwd && (firstLine(x.id) ?? '').trimEnd() === line)
    .sort((a, b) =>
      w.startedAt === undefined ? last(b) - last(a) : Math.abs(a.time.created - w.startedAt) - Math.abs(b.time.created - w.startedAt) || last(b) - last(a),
    )[0];
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

// First line of a session's first user message. `opencode --prompt <text>` writes the prompt
// as its first message, so this line identifies the session a prompt window runs. It never
// changes: fetch each session once per process and keep it here. A session without a first
// message yet (created empty) can gain one later, so empty results are retried after a
// minute and failed fetches after ten seconds - both bounds keep a drifted API from being
// refetched on every 2 s poll.
const firstLines = new Map<string, string>();
const firstLineRetry = new Map<string, number>();

async function firstLineOf(svc: Service, id: string, now = Date.now()): Promise<string | undefined> {
  const cached = firstLines.get(id);
  if (cached !== undefined) return cached;
  if ((firstLineRetry.get(id) ?? 0) > now) return undefined;
  let msgs: { type?: string; text?: string }[] | undefined;
  try {
    msgs = await api<{ type?: string; text?: string }[]>(svc, `/api/session/${id}/message?limit=1&order=asc`);
  } catch {
    firstLineRetry.set(id, now + 10_000);
    return undefined;
  }
  const [msg] = msgs ?? [];
  const line = msg?.type === 'user' && typeof msg.text === 'string' ? msg.text.split('\n')[0].trimEnd() : '';
  if (line) firstLines.set(id, line);
  else firstLineRetry.set(id, now + 60_000);
  return line || undefined;
}

export async function listOpencodeSessions(run: Runner, serviceFile?: string, ledgerFile?: string): Promise<OpencodeResult> {
  const svc = readService(serviceFile);
  if (!svc) return { sessions: [] };

  const [windows, sessions, active] = await Promise.all([
    listWindows(run),
    api<OcSession[]>(svc, '/api/session?limit=1000&order=desc'),
    api<Record<string, { type: string }>>(svc, '/api/session/active'),
  ]);

  // First message lines only matter where a window could be prompt-matched: top-level sessions
  // in a folder that currently has a window. One fetch per new session, then served from cache.
  const folders = new Set(windows.map((w) => w.cwd));
  await Promise.all(sessions.filter((x) => !x.parentID && folders.has(x.location.directory)).map((x) => firstLineOf(svc, x.id)));

  const live = await Promise.all(
    pickSessions(windows, sessions, (id) => firstLines.get(id)).map(async ({ window, session, guessed }) => {
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
        windowGuessed: guessed,
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
