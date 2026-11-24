import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { columnFor } from '../src/board';
import { addCodexHooks, CODEX_HOOK_EVENTS } from '../src/installHooks';
import { listCodexSessions, listUnlistedClaude, pickCodexSessions } from '../src/sources/codex';
import { EventStore } from '../src/sources/hookEvents';
import { codexCommand } from '../src/wezterm';

const hook = path.join(__dirname, '..', 'hooks', 'session-slayer-hook.sh');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));

it('hook script tags Codex lines; the store keeps cwd and model per session', () => {
  const dir = tmp();
  const send = (o: object, tool?: string) =>
    execFileSync('sh', tool ? [hook, tool] : [hook], { input: JSON.stringify(o), env: { ...process.env, SESSION_SLAYER_DIR: dir } });
  send({ session_id: 'cx1', hook_event_name: 'SessionStart', cwd: '/r', model: 'gpt-5.5' }, 'codex');
  send({ session_id: 'cx1', hook_event_name: 'PermissionRequest', cwd: '/r', tool_name: 'Bash' }, 'codex');
  send({ session_id: 'cl1', hook_event_name: 'Stop' });
  const s = new EventStore(path.join(dir, 'events.jsonl'));
  s.readNew();
  expect(s.hookSessions('codex')).toMatchObject([{ sessionId: 'cx1', tool: 'codex', cwd: '/r', model: 'gpt-5.5' }]);
  expect(s.hookSessions('claude').map((x) => x.sessionId)).toEqual(['cl1']);
  expect(s.lastEvent('cx1')?.event).toBe('PermissionRequest');
});

it('Codex columns: PermissionRequest waits, Stop and Interrupt are idle', () => {
  const live = { tool: 'codex' as const, sessionId: 'x', cwd: '/', kind: 'interactive' as const };
  const ev = (event: string) => ({ sessionId: 'x', event, ts: 1 });
  expect(columnFor(live, ev('UserPromptSubmit'))).toBe('working');
  expect(columnFor(live, ev('PermissionRequest'))).toBe('needs_input');
  expect(columnFor(live, ev('Stop'))).toBe('idle');
  expect(columnFor(live, ev('Interrupt'))).toBe('idle');
  expect(columnFor(live, undefined)).toBe('idle');
});

it('pickCodexSessions: newest session per window folder, one per window', () => {
  const s = (sessionId: string, cwd: string, lastTs: number) => ({ sessionId, tool: 'codex' as const, cwd, startedAt: 0, lastTs });
  const picked = pickCodexSessions(
    [
      { pid: 1, cwd: '/a' },
      { pid: 2, cwd: '/a' },
      { pid: 3, cwd: '/z' },
    ],
    [s('old', '/a', 1), s('new', '/a', 9), s('b', '/b', 5)],
  );
  expect(picked.map((p) => [p.window.pid, p.session.sessionId])).toEqual([
    [1, 'new'],
    [2, 'old'],
  ]);
});

it('pickCodexSessions: the prompt line pins the live session; a closed window s newer session never matches', () => {
  const s = (sessionId: string, cwd: string, lastTs: number) => ({ sessionId, tool: 'codex' as const, cwd, startedAt: 0, lastTs });
  const sessions = [s('dead', '/a', 9), s('live', '/a', 7)];
  const picked = pickCodexSessions([{ pid: 1, cwd: '/a', args: 'Fix the login redirect' }], sessions, (id) =>
    id === 'dead' ? 'close the tab' : 'Fix the login redirect',
  );
  expect(picked.map((p) => [p.window.pid, p.session.sessionId, p.guessed])).toEqual([[1, 'live', false]]);
  expect(picked.map((p) => p.session.sessionId)).not.toContain('dead');
});

it('pickCodexSessions: a stale twin of the same prompt leaves the pair a guess, but still the live session', () => {
  const s = (sessionId: string, cwd: string, lastTs: number) => ({ sessionId, tool: 'codex' as const, cwd, startedAt: 0, lastTs });
  const picked = pickCodexSessions([{ pid: 1, cwd: '/a', args: 'Fix the login redirect' }], [s('stale', '/a', 5), s('live', '/a', 7)], () =>
    'Fix the login redirect',
  );
  expect(picked.map((p) => [p.window.pid, p.session.sessionId, p.guessed])).toEqual([[1, 'live', true]]);
});

it('pickCodexSessions: identical batch prompts pair one session per window, but stay a guess', () => {
  const s = (sessionId: string, cwd: string, lastTs: number) => ({ sessionId, tool: 'codex' as const, cwd, startedAt: 0, lastTs });
  const args = 'same prompt';
  const picked = pickCodexSessions(
    [
      { pid: 1, cwd: '/a', args },
      { pid: 2, cwd: '/a', args },
    ],
    [s('a', '/a', 5), s('b', '/a', 9)],
    () => 'same prompt',
  );
  expect(picked.map((p) => [p.window.pid, p.session.sessionId, p.guessed])).toEqual([
    [1, 'b', true],
    [2, 'a', true],
  ]);
});

it('pickCodexSessions: a plain window cannot steal the session a later prompt window pins', () => {
  const s = (sessionId: string, cwd: string, lastTs: number) => ({ sessionId, tool: 'codex' as const, cwd, startedAt: 0, lastTs });
  const picked = pickCodexSessions([{ pid: 1, cwd: '/a' }, { pid: 2, cwd: '/a', args: 'fix the bug' }], [s('p', '/a', 9), s('q', '/a', 5)], (id) =>
    id === 'p' ? 'fix the bug' : undefined,
  );
  expect(picked.map((p) => [p.window.pid, p.session.sessionId, p.guessed])).toEqual([
    [1, 'q', true],
    [2, 'p', false],
  ]);
});

it('pickCodexSessions: a newer unclaimed session started after the window marks the pin guessed', () => {
  const start = 1_000_000;
  const s = (sessionId: string, cwd: string, startedAt: number, lastTs: number) => ({ sessionId, tool: 'codex' as const, cwd, startedAt, lastTs });
  const sessions = [s('p', '/a', start - 60_000, 100), s('new', '/a', start + 60_000, 200)];
  const w = { pid: 1, cwd: '/a', args: 'fix the bug', startedAt: start };
  const picked = pickCodexSessions([w], sessions, (id) => (id === 'p' ? 'fix the bug' : undefined));
  expect(picked.map((p) => [p.window.pid, p.session.sessionId, p.guessed])).toEqual([[1, 'p', true]]);
  const claimed = pickCodexSessions([w, { pid: 2, cwd: '/a' }], sessions, (id) => (id === 'p' ? 'fix the bug' : undefined));
  expect(claimed.map((p) => [p.window.pid, p.session.sessionId, p.guessed])).toEqual([
    [1, 'p', false],
    [2, 'new', true],
  ]);
});

it('finds resumed Codex windows by their resume id, and prompt windows by their first prompt line', async () => {
  const dir = tmp();
  const file = path.join(dir, 'events.jsonl');
  const id = '6ffbc9f1-7109-4b04-a2f2-e76a55b49daa';
  const line = (ts: number, sid: string, prompt?: string) =>
    JSON.stringify({ ts, tool: 'codex', hook: { session_id: sid, cwd: '/b', hook_event_name: 'UserPromptSubmit', ...(prompt ? { prompt } : {}) } });
  fs.writeFileSync(file, [line(1, id), line(2, 'p1', 'run the tests'), line(3, 'p2', 'fix the bug')].join('\n') + '\n');
  const events = new EventStore(file);
  events.readNew();
  const run = async (cmd: string) =>
    cmd === 'ps' ? ` 10 01:40 codex resume ${id}\n 20 01:40 codex run the tests\n 30 00:05 codex app-server` : 'p10\nn/b\np20\nn/b';
  const found = await listCodexSessions(run, events);
  expect(found.map((s) => [s.pid, s.sessionId])).toEqual([
    [10, id],
    [20, 'p1'],
  ]);
  expect(found[0].windowGuessed).toBeUndefined();
  expect(found[1].windowGuessed).toBe(false);
});

it('addCodexHooks: all events once, keeps other hooks', () => {
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'x.sh' }] };
  const once = addCodexHooks({ hooks: { PreToolUse: [other] } }, '/p/session-slayer-hook.sh');
  const twice = addCodexHooks(once, '/p/session-slayer-hook.sh');
  for (const e of CODEX_HOOK_EVENTS) expect(twice.hooks![e].filter((h) => h.hooks[0].command?.includes('session-slayer'))).toHaveLength(1);
  expect(twice.hooks!.PreToolUse[0]).toEqual(other);
  expect(twice.hooks!.Stop[0].hooks[0].command).toBe(`sh '/p/session-slayer-hook.sh' codex`);
});

it('codexCommand', () => {
  expect(codexCommand()).toBe('codex; exec zsh');
  expect(codexCommand('abc')).toBe("codex resume 'abc'; exec zsh");
});

it('finds Claude windows missing from `claude agents` through hook events', async () => {
  const dir = tmp();
  const file = path.join(dir, 'events.jsonl');
  const line = (ts: number, id: string, cwd: string) => JSON.stringify({ ts, hook: { session_id: id, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'go' } });
  fs.writeFileSync(file, [line(1, 'listed', '/a'), line(2, 'old', '/b'), line(3, 'new', '/b')].join('\n') + '\n');
  const events = new EventStore(file);
  events.readNew();
  const run = async (cmd: string) =>
    cmd === 'ps'
      ? ' 10 00:05 /bin/claude\n 20 00:05 claude /plan x\n 30 00:05 claude agents --json\n 40 00:05 zsh -lic claude\n 50 00:05 claude update\n 60 00:05 claude mcp serve'
      : 'p10\nn/a\np20\nn/b\np30\nn/c';
  const found = await listUnlistedClaude(run, events, [{ tool: 'claude', sessionId: 'listed', pid: 10, cwd: '/a', kind: 'interactive' }]);
  expect(found.map((s) => [s.pid, s.sessionId])).toEqual([[20, 'new']]);
});

it('prompt words that look like subcommands do not hide a Claude window', async () => {
  const dir = tmp();
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, JSON.stringify({ ts: 1, hook: { session_id: 'u1', cwd: '/b', hook_event_name: 'UserPromptSubmit', prompt: 'x' } }) + '\n');
  const events = new EventStore(file);
  events.readNew();
  const run = async (cmd: string) => (cmd === 'ps' ? ' 20 00:05 claude update the changelog' : 'p20\nn/b');
  const found = await listUnlistedClaude(run, events, []);
  expect(found.map((s) => [s.pid, s.sessionId])).toEqual([[20, 'u1']]);
});

it('finds resumed Claude windows by their --resume id, even after a SessionEnd', async () => {
  const dir = tmp();
  const file = path.join(dir, 'events.jsonl');
  const id = '6ffbc9f1-7109-4b04-a2f2-e76a55b49daa';
  fs.writeFileSync(file, JSON.stringify({ ts: 5, hook: { session_id: id, cwd: '/b', hook_event_name: 'SessionEnd' } }) + '\n');
  const events = new EventStore(file);
  events.readNew();
  const run = async (cmd: string) => (cmd === 'ps' ? ` 20 00:05 claude --resume ${id}` : 'p20\nn/b');
  const found = await listUnlistedClaude(run, events, []);
  expect(found).toMatchObject([{ pid: 20, sessionId: id, startedAt: 6 }]);
});
