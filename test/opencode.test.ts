import { expect, it } from 'vitest';
import { columnFor } from '../src/board';
import { listWindows, type OcSession, pickSessions } from '../src/sources/opencode';
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
      ? '  98538 opencode\n  98620 /Users/me/.opencode/bin/opencode serve --service\n  100 /bin/zsh\n  101 /Users/me/.opencode/bin/opencode -s ses_1\n'
      : 'p98538\nfcwd\nn/Users/me/dev/a\np101\nfcwd\nn/Users/me/dev/b\n';
  expect(await listWindows(run)).toEqual([
    { pid: 98538, cwd: '/Users/me/dev/a' },
    { pid: 101, cwd: '/Users/me/dev/b' },
  ]);
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

it('columnFor opencode: busy, idle, waiting', () => {
  const oc = (o: Partial<LiveSession>): LiveSession => ({ tool: 'opencode', sessionId: 's', cwd: '/', kind: 'interactive', ...o });
  expect(columnFor(oc({ status: 'busy' }), undefined)).toBe('working');
  expect(columnFor(oc({ status: 'idle' }), undefined)).toBe('idle');
  expect(columnFor(oc({ status: 'busy', state: 'blocked' }), undefined)).toBe('needs_input');
});
