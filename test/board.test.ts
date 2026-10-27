import { describe, expect, it } from 'vitest';
import { buildCards, columnFor } from '../src/board';
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
  const base = { lastEvent: () => undefined, firstPrompt: () => undefined, names: {}, weztermSessions: new Set<string>(), home: '/h' };

  it('keeps columnSince while the column stays, resets when it changes', () => {
    const since = new Map();
    const a = buildCards({ ...base, sessions: [live()], since, now: 100 });
    const b = buildCards({ ...base, sessions: [live()], since, now: 200 });
    const c = buildCards({ ...base, sessions: [live({ status: 'busy' })], since, now: 300 });
    expect([a[0].columnSince, b[0].columnSince, c[0].columnSince]).toEqual([100, 100, 300]);
  });
  it('stored name wins over claude name; fireline lane from name', () => {
    const [card] = buildCards({ ...base, sessions: [live({ name: 'auto', cwd: '/h/dev/repo' })], names: { s1: 'FIRE-9 x' }, since: new Map(), now: 0 });
    expect(card).toMatchObject({ name: 'FIRE-9 x', lane: 'fireline', repo: 'repo', ticket: 'FIRE-9' });
  });
});

it('lane order: fireline, repos by name, other', () => {
  expect(sortLanes(['other', 'b', 'fireline', 'a'])).toEqual(['fireline', 'a', 'b', 'other']);
});
