import { describe, expect, it } from 'vitest';
import { buildCards, columnFor, endsWithQuestion } from '../src/board';
import { sortLanes } from '../src/lanes';
import type { LiveSession, SessionEvent } from '../src/types';

const live = (o: Partial<LiveSession> = {}): LiveSession => ({ tool: 'claude', sessionId: 's1', cwd: '/x', kind: 'interactive', status: 'idle', ...o });
const ev = (event: string, o: Partial<SessionEvent> = {}): SessionEvent => ({ sessionId: 's1', event, ts: 1, ...o });

describe('columnFor', () => {
  it.each([
    ['UserPromptSubmit', {}, 'working'],
    ['PostToolUse', {}, 'working'],
    ['PreToolUse', { toolName: 'Bash' }, 'working'],
    ['PreToolUse', { toolName: 'AskUserQuestion' }, 'needs_input'],
    ['PreToolUse', { toolName: 'ExitPlanMode' }, 'needs_input'],
    ['Notification', { notificationKind: 'permission' }, 'needs_input'],
    ['Stop', {}, 'idle'],
    ['Stop', { asks: true }, 'needs_input'],
  ] as const)('%s %o -> %s', (event, extra, col) => {
    expect(columnFor(live(), ev(event, extra))).toBe(col);
  });

  it('idle notification has no opinion: falls back to status', () => {
    expect(columnFor(live({ status: 'idle' }), ev('Notification', { notificationKind: 'idle' }))).toBe('idle');
  });
  it('no events: busy/idle and background state', () => {
    expect(columnFor(live({ status: 'busy' }), undefined)).toBe('working');
    expect(columnFor(live({ status: 'idle' }), undefined)).toBe('idle');
    expect(columnFor(live({ kind: 'background', state: 'blocked' }), undefined)).toBe('needs_input');
    expect(columnFor(live({ kind: 'background', state: 'running' }), undefined)).toBe('working');
  });
  it('Stop but busy -> working', () => {
    expect(columnFor(live({ status: 'busy' }), ev('Stop'))).toBe('working');
  });
});

describe('buildCards', () => {
  const base = { lastEvent: () => undefined, firstPrompt: () => undefined, names: {}, weztermSessions: new Set<string>(), titles: new Map<string, string>(), branches: new Map([['/h/dev/repo', { branch: 'main' }]]), home: '/h' };

  it('keeps columnSince while the column stays, resets when it changes', () => {
    const since = new Map();
    const a = buildCards({ ...base, sessions: [live()], since, now: 100 });
    const b = buildCards({ ...base, sessions: [live()], since, now: 200 });
    const c = buildCards({ ...base, sessions: [live({ status: 'busy' })], since, now: 300 });
    expect([a[0].columnSince, b[0].columnSince, c[0].columnSince]).toEqual([100, 100, 300]);
  });
  it('stored name wins over claude name; ticket lane from name', () => {
    const [card] = buildCards({ ...base, sessions: [live({ name: 'auto', cwd: '/h/dev/repo' })], names: { s1: 'OPS-9 x' }, since: new Map(), now: 0 });
    expect(card).toMatchObject({ name: 'OPS-9 x', lane: 'OPS', laneKind: 'ticket', repo: 'repo', ticket: 'OPS-9', branch: 'main' });
  });
});

it('lane order: ticket projects, then repos, then other; by name inside each', () => {
  const l = (lane: string, laneKind: 'ticket' | 'repo' | 'other') => ({ lane, laneKind });
  expect(sortLanes([l('other', 'other'), l('b', 'repo'), l('OPS', 'ticket'), l('a', 'repo'), l('ABC', 'ticket'), l('a', 'repo')])).toEqual(['ABC', 'OPS', 'a', 'b', 'other']);
});

it('name order: user name, tab title, first prompt, "New session"; never Claude name', () => {
  const base = { lastEvent: () => undefined, names: {}, weztermSessions: new Set<string>(), branches: new Map(), since: new Map(), now: 0, home: '/h' };
  const s = [live({ name: 'my-repo-d7' })];
  const n = (o: object) => buildCards({ ...base, titles: new Map(), firstPrompt: () => undefined, sessions: s, ...o })[0];
  expect(n({ names: { s1: 'mine' }, titles: new Map([['s1', 'Title']]) })).toMatchObject({ name: 'mine', nameSource: 'user' });
  expect(n({ titles: new Map([['s1', 'Title']]), firstPrompt: () => 'p' })).toMatchObject({ name: 'Title', nameSource: 'title' });
  expect(n({ firstPrompt: () => 'x'.repeat(80) })).toMatchObject({ name: 'x'.repeat(60), nameSource: 'prompt' });
  expect(n({})).toMatchObject({ name: 'New session', nameSource: 'none' });
});

it('parseGitInfo: branch, detached HEAD, linked worktree', async () => {
  const { parseGitInfo } = await import('../src/board');
  expect(parseGitInfo('main\n/r\n/r/.git\n/r/.git\n')).toEqual({ branch: 'main', worktree: undefined });
  expect(parseGitInfo('HEAD\n/r\n/r/.git\n/r/.git\n')).toEqual({ branch: undefined, worktree: undefined });
  expect(parseGitInfo('feat\n/r/.claude/worktrees/fix-x\n/r/.git/worktrees/fix-x\n/r/.git\n')).toEqual({ branch: 'feat', worktree: 'fix-x' });
});

it('columnSince prefers the event time, then the source time, then first seen', () => {
  const base = { lastEvent: () => undefined, firstPrompt: () => undefined, names: {}, weztermSessions: new Set<string>(), titles: new Map(), branches: new Map(), home: '/h', now: 999 };
  const card = (o: object) => buildCards({ ...base, sessions: [live()], since: new Map(), ...o })[0].columnSince;
  expect(card({ eventSince: () => ({ column: 'idle', since: 5 }) })).toBe(5);
  expect(card({ eventSince: () => ({ column: 'working', since: 5 }) })).toBe(999); // event column disagrees
  expect(buildCards({ ...base, sessions: [live({ columnSince: 7 })], since: new Map() })[0].columnSince).toBe(7);
  expect(card({})).toBe(999);
});

describe('endsWithQuestion', () => {
  it.each([
    ['Shall I commit?', true],
    ['Done.\n\nOi, **A or B?**', true],
    ['Which one (A or B?)', true],
    ['Is it fixed? Yes.\n\nAll done.', false],
    ['Why? Because.', false],
    ['', false],
    [undefined, false],
  ] as const)('%j -> %s', (text, want) => {
    expect(endsWithQuestion(text)).toBe(want);
  });
});
