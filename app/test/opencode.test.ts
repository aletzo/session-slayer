import { expect, it } from 'vitest';
import { columnFor } from '../src/board';
import { argPromptLine, argSessionId, listWindows, type OcSession, pickSessions } from '../src/sources/opencode';
import type { LiveSession } from '../src/types';

const ses = (id: string, dir: string, updated: number, o: Partial<OcSession> = {}): OcSession => ({
  id,
  time: { created: 0, updated },
  location: { directory: dir },
  ...o,
});

it('listWindows: opencode windows only, not the background service', async () => {
  const run = async (cmd: string) =>
    cmd === 'ps'
      ? '  98538 01:40 opencode\n  98620 00:05 /Users/me/.opencode/bin/opencode serve --service\n  100 00:10 /bin/zsh\n  101 00:20 /Users/me/.opencode/bin/opencode -s ses_1\n'
      : 'p98538\nfcwd\nn/Users/me/dev/a\np101\nfcwd\nn/Users/me/dev/b\n';
  const windows = await listWindows(run);
  expect(windows).toMatchObject([
    { pid: 98538, cwd: '/Users/me/dev/a' },
    { pid: 101, cwd: '/Users/me/dev/b' },
  ]);
  for (const w of windows) expect(w.startedAt).toBeLessThan(Date.now());
});

it('argPromptLine: the whole --prompt value, first line only', () => {
  expect(argPromptLine('opencode --prompt fix the lint /a', '/a')).toBe('fix the lint');
  expect(argPromptLine('opencode --prompt=fix the lint /a', '/a')).toBe('fix the lint');
  expect(argPromptLine('opencode --prompt line1\\012line2 /a', '/a')).toBe('line1');
  expect(argPromptLine('opencode --prompt fix the lint', '/a')).toBe('fix the lint');
  expect(argPromptLine('opencode -s ses_x', '/a')).toBeUndefined();
  expect(argPromptLine(undefined, '/a')).toBeUndefined();
});

it('pickSessions: newest top-level session per folder, one session per window', () => {
  const sessions = [
    ses('old', '/a', 1),
    ses('new', '/a', 5),
    ses('child', '/a', 9, { parentID: 'new' }),
    ses('viewed', '/a', 2, { time: { created: 0, updated: 2, viewed: 7 } }),
    ses('b1', '/b', 1),
  ];
  const picked = pickSessions(
    [
      { pid: 1, cwd: '/a' },
      { pid: 2, cwd: '/a' },
      { pid: 3, cwd: '/c' },
    ],
    sessions,
  );
  expect(picked.map((p) => [p.window.pid, p.session.id])).toEqual([
    [1, 'viewed'],
    [2, 'new'],
  ]);
});

it('argSessionId: -s and --session ids, quoted or =, nothing else', () => {
  expect(argSessionId("opencode -s 'ses_x1'")).toBe('ses_x1');
  expect(argSessionId('opencode --session=ses_x2 /dir')).toBe('ses_x2');
  expect(argSessionId('opencode --session ses_x3 /dir')).toBe('ses_x3');
  expect(argSessionId('opencode --prompt mention -s without an id')).toBeUndefined();
  expect(argSessionId(undefined)).toBeUndefined();
});

it('pickSessions: -s pins the window to its session even when a newer session shares the folder', () => {
  const sessions = [ses('ses_newer', '/a', 9), ses('ses_mine', '/a', 2)];
  const picked = pickSessions([{ pid: 1, cwd: '/a', args: "opencode -s 'ses_mine'" }], sessions);
  expect(picked.map((p) => [p.window.pid, p.session.id, p.guessed])).toEqual([[1, 'ses_mine', false]]);
});

it('pickSessions: -s naming a missing or child session falls back to recency, still a guess', () => {
  const sessions = [ses('ses_real', '/a', 5), ses('ses_child', '/a', 9, { parentID: 'ses_real' })];
  for (const args of ['-s ses_gone', '-s ses_child']) {
    const picked = pickSessions([{ pid: 1, cwd: '/a', args }], sessions);
    expect(picked.map((p) => [p.session.id, p.guessed])).toEqual([['ses_real', true]]);
  }
});

it('pickSessions: --prompt text pins its session, so a closed window with a newer session loses', () => {
  // The board bug: a closed window's session (wip) was the newest in the folder, so the
  // recency fallback showed it and hid the live PROJ-7022 session.
  const dir = '/mono';
  const line: Record<string, string> = {
    wip: 'Continue from a handover. Read WIP-board.md first',
    live: 'Continue ticket PROJ-7022 from a handover. Read PROJ-7022.md first',
    six: 'Continue from a handover. Read PROJ-6965.md first',
  };
  const sessions = [ses('wip', dir, 27), ses('live', dir, 26), ses('six', dir, 25)];
  const windows = [
    { pid: 79147, cwd: dir, args: `opencode --prompt ${line.live} ${dir}` },
    { pid: 8474, cwd: dir, args: `opencode --prompt ${line.six} ${dir}` },
  ];
  const picked = pickSessions(windows, sessions, (id) => line[id]);
  expect(picked.map((p) => [p.window.pid, p.session.id, p.guessed])).toEqual([
    [79147, 'live', false],
    [8474, 'six', false],
  ]);
  expect(picked.map((p) => p.session.id)).not.toContain('wip');
});

it('pickSessions: identical batch prompts pair one session per window, but stay a guess', () => {
  const sessions = [ses('a', '/a', 5), ses('b', '/a', 9)];
  const args = 'opencode --prompt same text /a';
  const picked = pickSessions(
    [
      { pid: 1, cwd: '/a', args },
      { pid: 2, cwd: '/a', args },
    ],
    sessions,
    () => 'same text',
  );
  expect(picked.map((p) => [p.window.pid, p.session.id, p.guessed])).toEqual([
    [1, 'b', true],
    [2, 'a', true],
  ]);
});

it('pickSessions: a stale twin of the same prompt leaves the pair a guess, but still the live session', () => {
  const dir = '/mono';
  const livePrompt = 'Continue ticket PROJ-7022 from a handover. Read PROJ-7022.md first';
  const wip = 'Continue from a handover. Read WIP-board.md first';
  const sessions = [ses('wip', dir, 27), ses('stale', dir, 24), ses('live', dir, 26)];
  const picked = pickSessions([{ pid: 79147, cwd: dir, args: `opencode --prompt ${livePrompt} ${dir}` }], sessions, (id) => (id === 'wip' ? wip : livePrompt));
  expect(picked.map((p) => [p.window.pid, p.session.id, p.guessed])).toEqual([[79147, 'live', true]]);
  expect(picked.map((p) => p.session.id)).not.toContain('wip');
});

it('pickSessions: a short prompt line never matches a longer window prompt', () => {
  const sessions = [ses('fix', '/a', 9), ses('live', '/a', 7)];
  const picked = pickSessions([{ pid: 1, cwd: '/a', args: 'opencode --prompt fix the lint errors /a' }], sessions, (id) =>
    id === 'fix' ? 'fix' : 'fix the lint errors',
  );
  expect(picked.map((p) => [p.window.pid, p.session.id, p.guessed])).toEqual([[1, 'live', false]]);
  expect(picked.map((p) => p.session.id)).not.toContain('fix');
});

it('pickSessions: a plain window cannot steal the session a later -s window pins', () => {
  const sessions = [ses('ses_x', '/a', 9), ses('y', '/a', 5)];
  const picked = pickSessions(
    [
      { pid: 1, cwd: '/a' },
      { pid: 2, cwd: '/a', args: '-s ses_x' },
    ],
    sessions,
  );
  expect(picked.map((p) => [p.window.pid, p.session.id, p.guessed])).toEqual([
    [1, 'y', true],
    [2, 'ses_x', false],
  ]);
});

it('pickSessions: a newer unclaimed session born after the window started marks the pin guessed', () => {
  const start = 1_000_000;
  const w: { pid: number; cwd: string; args: string; startedAt: number } = { pid: 1, cwd: '/a', args: '-s ses_x', startedAt: start };
  const sessions = [
    ses('ses_x', '/a', 100, { time: { created: start - 60_000, updated: 100 } }),
    ses('new', '/a', 200, { time: { created: start + 60_000, updated: 200 } }),
  ];
  const picked = pickSessions([w], sessions);
  expect(picked.map((p) => [p.window.pid, p.session.id, p.guessed])).toEqual([[1, 'ses_x', true]]);
  const claimed = pickSessions([w, { pid: 2, cwd: '/a' }], sessions);
  expect(claimed.map((p) => [p.window.pid, p.session.id, p.guessed])).toEqual([
    [1, 'ses_x', false],
    [2, 'new', true],
  ]);
});

it('columnFor opencode: busy, idle, waiting', () => {
  const oc = (o: Partial<LiveSession>): LiveSession => ({ tool: 'opencode', sessionId: 's', cwd: '/', kind: 'interactive', ...o });
  expect(columnFor(oc({ status: 'busy' }), undefined)).toBe('working');
  expect(columnFor(oc({ status: 'idle' }), undefined)).toBe('idle');
  expect(columnFor(oc({ status: 'busy', state: 'blocked' }), undefined)).toBe('needs_input');
});
