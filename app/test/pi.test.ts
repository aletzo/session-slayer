import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sessionSlayer, { eventLine, lastAssistantText } from '../hooks/session-slayer-pi';
import { installPiExtension, uninstallPiExtension } from '../src/installHooks';
import { EventStore, parseLine } from '../src/sources/hookEvents';
import { livePiSessions, parsePs } from '../src/sources/pi';

describe('pi extension', () => {
  it('last assistant text', () => {
    expect(lastAssistantText([
      { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'thinking', text: 'hm' }, { type: 'text', text: 'Oi, ok?' }] },
      { role: 'toolResult', content: [] },
    ])).toBe('Oi, ok?');
    expect(lastAssistantText('nope')).toBeUndefined();
  });

  it('writes Claude-style lines with tool pi and its pid, which the board parses', () => {
    const e = parseLine(eventLine(5, 42, 's1', '/r', 'Stop', { last_assistant_message: 'done?' }));
    expect(e).toMatchObject({ sessionId: 's1', event: 'Stop', ts: 5, tool: 'pi', pid: 42, cwd: '/r', reply: 'done?', asks: true });
  });

  it('maps pi events to board events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-pi-'));
    process.env.SESSION_SLAYER_DIR = dir;
    const handlers = new Map<string, (e: any, ctx: any) => unknown>();
    sessionSlayer({ on: (name, h) => handlers.set(name, h) });
    const ctx = { cwd: '/r', model: { id: 'sonnet' }, sessionManager: { getSessionId: () => 's1' } };
    handlers.get('session_start')!({}, ctx);
    handlers.get('input')!({ text: 'no model yet' }, ctx); // no run starts: nothing written
    handlers.get('input')!({ text: 'fix it' }, ctx);
    handlers.get('agent_start')!({}, ctx);
    handlers.get('agent_end')!({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'fixed' }] }] }, ctx);
    delete process.env.SESSION_SLAYER_DIR;
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => parseLine(l)!);
    expect(events.map((e) => [e.event, e.prompt ?? null])).toEqual([['SessionStart', null], ['UserPromptSubmit', 'fix it'], ['Stop', null]]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n')[2]).hook.last_assistant_message).toBe('fixed');
    const store = new EventStore(path.join(dir, 'events.jsonl'));
    store.readNew();
    expect(store.hookSessions('pi')).toMatchObject([{ sessionId: 's1', cwd: '/r', pid: process.pid, model: 'sonnet' }]);
  });
});

describe('livePiSessions', () => {
  const s = (sessionId: string, pid: number, startedAt: number, lastTs: number) => ({ sessionId, tool: 'pi' as const, cwd: '/r', pid, startedAt, lastTs });
  const pi = (start: number) => ({ start, args: 'node /usr/local/bin/pi' });

  it('only running pi processes, newest session per process', () => {
    const procs = new Map([[1, pi(0)], [3, { start: 0, args: 'node server.js' }]]);
    const live = livePiSessions([s('old', 1, 10, 10), s('new', 1, 10, 20), s('dead', 2, 10, 30), s('not-pi', 3, 10, 30)], procs);
    expect(live.map((x) => [x.sessionId, x.pid, x.tool])).toEqual([['new', 1, 'pi']]);
  });

  it('a pid reused by a pi started after the session is not the session', () => {
    expect(livePiSessions([s('crashed', 1, 1_000, 2_000)], new Map([[1, pi(60_000)]]))).toEqual([]);
  });

  it('parses ps lstart lines', () => {
    const procs = parsePs('  42 Fri Nov 20 11:23:42 2026     node /x/bin/pi -c\nbad line\n');
    expect(procs.get(42)).toEqual({ start: Date.parse('Fri Nov 20 11:23:42 2026'), args: 'node /x/bin/pi -c' });
    expect(procs.size).toBe(1);
  });
});

describe('pi extension install', () => {
  it('links once, removes only its own link', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-pi-')), 'extensions');
    expect(installPiExtension(dir, '/skill/hooks/session-slayer-pi.ts')).toBe(true);
    expect(installPiExtension(dir, '/skill/hooks/session-slayer-pi.ts')).toBe(false);
    expect(fs.readlinkSync(path.join(dir, 'session-slayer.ts'))).toBe('/skill/hooks/session-slayer-pi.ts');
    expect(uninstallPiExtension(dir)).toBe(true);
    expect(uninstallPiExtension(dir)).toBe(false);
  });
});
