import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { columnFor } from '../src/board';
import { addCodexHooks, CODEX_HOOK_EVENTS } from '../src/installHooks';
import { listUnlistedClaude, pickCodexSessions } from '../src/sources/codex';
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

it('addCodexHooks: all events once, keeps other hooks', () => {
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'x.sh' }] };
  const once = addCodexHooks({ hooks: { PreToolUse: [other] } }, '/p/session-slayer-hook.sh');
  const twice = addCodexHooks(once, '/p/session-slayer-hook.sh');
  for (const e of CODEX_HOOK_EVENTS) expect(twice.hooks![e].filter((h) => h.hooks[0].command.includes('session-slayer'))).toHaveLength(1);
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
      ? ' 10 /bin/claude\n 20 claude /lm-move x\n 30 claude agents --json\n 40 zsh -lic claude'
      : 'p10\nn/a\np20\nn/b\np30\nn/c';
  const found = await listUnlistedClaude(run, events, [{ tool: 'claude', sessionId: 'listed', pid: 10, cwd: '/a', kind: 'interactive' }]);
  expect(found.map((s) => [s.pid, s.sessionId])).toEqual([[20, 'new']]);
});
