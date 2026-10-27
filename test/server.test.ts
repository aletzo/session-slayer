import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { App } from '../src/app';
import { Names } from '../src/names';
import { createServer } from '../src/server';
import { EventStore } from '../src/sources/hookEvents';
import { WezTerm } from '../src/wezterm';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
fs.mkdirSync(path.join(dir, 'dev', 'repo-a'), { recursive: true });
fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: 1, hook: { session_id: 'done1', hook_event_name: 'Stop' } }) + '\n');

const calls: string[][] = [];
const run = async (cmd: string, args: string[]) => {
  calls.push([cmd, ...args]);
  if (args[0] === '--version') return 'wezterm 1';
  if (args[1] === 'list') return JSON.stringify([{ pane_id: 5, tty_name: '/dev/ttys001' }]);
  if (cmd === 'ps') return '100 ttys001\n';
  if (args[1] === 'spawn') return '9';
  if (cmd === 'git') return 'feature-x\n/r\n/r/.git\n/r/.git\n';
  return '';
};

const app = new App({
  run,
  events: new EventStore(path.join(dir, 'events.jsonl')),
  names: new Names(path.join(dir, 'names.json')),
  wezterm: new WezTerm(run, 'wezterm'),
  home: dir,
  listSessions: async () => [
    { tool: 'claude', sessionId: 'done1', pid: 100, cwd: path.join(dir, 'dev', 'repo-a'), kind: 'interactive', status: 'idle' },
    { tool: 'claude', sessionId: 'busy1', pid: 200, startedAt: 10, cwd: '/tmp', kind: 'interactive', status: 'busy' },
  ],
});
const server = createServer(app);
let base = '';

beforeAll(async () => {
  await app.poll();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const req = (method: string, p: string, body?: unknown) =>
  fetch(base + p, { method, body: body ? JSON.stringify(body) : undefined });

it('board', async () => {
  const b = await (await req('GET', '/api/board')).json();
  expect(b.cards.map((c: { sessionId: string; column: string; inWezterm: boolean }) => [c.sessionId, c.column, c.inWezterm])).toEqual([
    ['done1', 'idle', true],
    ['busy1', 'working', false],
  ]);
});

it('branch from git', async () => {
  const b = await (await req('GET', '/api/board')).json();
  expect(b.cards[0].branch).toBe('feature-x');
});

it('focus a WezTerm session', async () => {
  calls.length = 0;
  expect((await req('POST', '/api/sessions/done1/focus')).status).toBe(200);
  expect(calls[0]).toEqual(['wezterm', 'cli', 'activate-pane', '--pane-id', '5']);
});

it('focus outside WezTerm returns a message', async () => {
  const r = await (await req('POST', '/api/sessions/busy1/focus')).json();
  expect(r.message).toMatch(/Not in WezTerm/);
});

it('close: 409 when not idle, kills the pane when idle', async () => {
  expect((await req('POST', '/api/sessions/busy1/close')).status).toBe(409);
  calls.length = 0;
  expect((await req('POST', '/api/sessions/done1/close')).status).toBe(200);
  expect(calls).toContainEqual(['wezterm', 'cli', 'kill-pane', '--pane-id', '5']);
});

it('rename', async () => {
  await req('PUT', '/api/sessions/busy1/name', { name: 'FIRE-1 thing' });
  const b = await (await req('GET', '/api/board')).json();
  expect(b.cards.find((c: { sessionId: string }) => c.sessionId === 'busy1')).toMatchObject({ name: 'FIRE-1 thing', lane: 'fireline' });
});

it('new session: only known repos', async () => {
  expect((await req('POST', '/api/sessions', { repo: '../etc' })).status).toBe(400);
  expect(await (await req('GET', '/api/repos')).json()).toEqual(['repo-a']);
  calls.length = 0;
  expect((await req('POST', '/api/sessions', { repo: 'repo-a', name: 'x' })).status).toBe(200);
  expect(calls).toContainEqual(['wezterm', 'cli', 'spawn', '--cwd', path.join(dir, 'dev', 'repo-a'), '--', 'zsh', '-lic', `claude -n 'x'; exec zsh`]);
});

it('unknown session -> 404', async () => {
  expect((await req('POST', '/api/sessions/nope/focus')).status).toBe(404);
});

it('move: 409 when in WezTerm or not idle', async () => {
  expect((await req('POST', '/api/sessions/busy1/move')).status).toBe(409);
});

it('move: stops the process, then resumes in WezTerm', async () => {
  const killed: number[] = [];
  const kill = process.kill;
  process.kill = ((pid: number) => (killed.push(pid), true)) as typeof process.kill;
  app.rename('busy1', '');
  const s = app as unknown as { sessions: { sessionId: string; status: string; pid: number }[] };
  s.sessions.push({ ...s.sessions[1], sessionId: 'warp1', status: 'idle', pid: 300 } as never);
  calls.length = 0;
  try {
    await app.moveToWezterm('warp1', async () => {});
  } finally {
    process.kill = kill;
  }
  expect(killed).toEqual([300]);
  expect(calls).toContainEqual(['wezterm', 'cli', 'spawn', '--cwd', '/tmp', '--', 'zsh', '-lic', `claude --resume 'warp1'; exec zsh`]);
});

it('SessionEnd hides a session only if it started before the end event', async () => {
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: 5, hook: { session_id: 'busy1', hook_event_name: 'SessionEnd' } }) + '\n');
  await app.poll();
  expect(app.board().cards.some((c) => c.sessionId === 'busy1')).toBe(true); // startedAt 10 > 5: resumed
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: 50, hook: { session_id: 'busy1', hook_event_name: 'SessionEnd' } }) + '\n');
  await app.poll();
  expect(app.board().cards.some((c) => c.sessionId === 'busy1')).toBe(false);
});
