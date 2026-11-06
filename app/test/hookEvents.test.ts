import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EventStore, parseLine, recapFromTranscript } from '../src/sources/hookEvents';

const line = (hook: object, ts = 1) => JSON.stringify({ ts, hook }) + '\n';
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-')), 'events.jsonl');

describe('parseLine', () => {
  it('notification kinds', () => {
    const n = (o: object) => parseLine(line({ session_id: 'a', hook_event_name: 'Notification', ...o }))?.notificationKind;
    expect(n({ notification_type: 'permission_prompt' })).toBe('permission');
    expect(n({ message: 'Claude needs your permission to use Bash' })).toBe('permission');
    expect(n({ message: 'Claude is waiting for your input' })).toBe('idle');
    expect(n({ message: 'something' })).toBe('other');
  });
  it('bad lines -> null', () => {
    expect(parseLine('nope')).toBeNull();
    expect(parseLine('{"ts":1,"hook":{}}')).toBeNull();
  });
});

describe('EventStore', () => {
  it('reads only new lines, skips bad ones, handles a partial last line', () => {
    const f = tmp();
    fs.writeFileSync(f, line({ session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'first' }) + 'garbage\n');
    const s = new EventStore(f);
    expect(s.readNew()).toBe(true);
    expect(s.lastEvent('a')?.event).toBe('UserPromptSubmit');
    expect(s.readNew()).toBe(false);

    const next = line({ session_id: 'a', hook_event_name: 'Stop' });
    fs.appendFileSync(f, line({ session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'second' }) + next.slice(0, 10));
    s.readNew();
    fs.appendFileSync(f, next.slice(10));
    s.readNew();
    expect(s.lastEvent('a')?.event).toBe('Stop');
    expect(s.firstPrompt('a')).toBe('first');
  });
  it('idle notifications do not replace the last event; SessionEnd marks ended', () => {
    const f = tmp();
    fs.writeFileSync(f, line({ session_id: 'a', hook_event_name: 'Stop' }) + line({ session_id: 'a', hook_event_name: 'Notification', notification_type: 'idle_prompt' }) + line({ session_id: 'b', hook_event_name: 'SessionEnd' }));
    const s = new EventStore(f);
    s.readNew();
    expect(s.lastEvent('a')?.event).toBe('Stop');
    expect(s.ended.has('b')).toBe(true);
  });
  it('compact keeps live sessions only', () => {
    const f = tmp();
    fs.writeFileSync(f, line({ session_id: 'a', hook_event_name: 'Stop' }) + line({ session_id: 'dead', hook_event_name: 'Stop' }) + 'bad\n');
    new EventStore(f).compact(new Set(['a']));
    expect(fs.readFileSync(f, 'utf8')).toBe(line({ session_id: 'a', hook_event_name: 'Stop' }));
  });
  it('compact picks up lines left by a compact that crashed', () => {
    const f = tmp();
    const a = line({ session_id: 'a', hook_event_name: 'Stop' });
    const b = line({ session_id: 'a', hook_event_name: 'UserPromptSubmit' });
    fs.writeFileSync(`${f}.compacting`, a);
    fs.writeFileSync(f, b);
    new EventStore(f).compact(new Set(['a']));
    expect(fs.readFileSync(f, 'utf8')).toBe(a + b);
    expect(fs.existsSync(`${f}.compacting`)).toBe(false);
  });
  it('compact keeps lines that hooks write while it runs', () => {
    const f = tmp();
    const kept = line({ session_id: 'a', hook_event_name: 'Stop' });
    const during = line({ session_id: 'a', hook_event_name: 'UserPromptSubmit' });
    fs.writeFileSync(f, kept);
    const read = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      // A hook appends right after compact read the old lines.
      const out = read(p, o as BufferEncoding);
      if (String(p).endsWith('.compacting')) fs.appendFileSync(f, during);
      return out;
    }) as typeof fs.readFileSync);
    new EventStore(f).compact(new Set(['a']));
    spy.mockRestore();
    expect(fs.readFileSync(f, 'utf8')).toBe(kept + during);
    expect(fs.existsSync(`${f}.compacting`)).toBe(false);
  });
});

it('a later event after SessionEnd clears it (resumed session)', () => {
  const f = tmp();
  fs.writeFileSync(f, line({ session_id: 'a', hook_event_name: 'SessionEnd' }, 5) + line({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, 9));
  const s = new EventStore(f);
  s.readNew();
  expect(s.ended.has('a')).toBe(false);
});

it('columnSince: start of the current column streak, kept across restarts', () => {
  const f = tmp();
  fs.writeFileSync(
    f,
    line({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, 10) +
      line({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 20) +
      line({ session_id: 'a', hook_event_name: 'Stop' }, 30) +
      line({ session_id: 'a', hook_event_name: 'Notification', notification_type: 'idle_prompt' }, 40),
  );
  const s = new EventStore(f);
  s.readNew();
  expect(s.columnSince('a')).toEqual({ column: 'idle', since: 30 });
  fs.appendFileSync(f, line({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, 50) + line({ session_id: 'a', hook_event_name: 'PostToolUse' }, 60));
  s.readNew();
  expect(s.columnSince('a')).toEqual({ column: 'working', since: 50 });
});

describe('recapFromTranscript', () => {
  it('returns the latest away_summary without the config hint', () => {
    const claude = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-'));
    fs.mkdirSync(path.join(claude, 'projects', 'p'), { recursive: true });
    const line = (content: string, ts: string) => JSON.stringify({ type: 'system', subtype: 'away_summary', content, timestamp: ts });
    fs.writeFileSync(
      path.join(claude, 'projects', 'p', 's1.jsonl'),
      [line('old', '2026-11-03T08:00:00Z'), JSON.stringify({ type: 'user', message: { content: 'hi' } }), line('new one (disable recaps in /config)', '2026-11-03T09:00:00Z'), '{"partial'].join('\n'),
    );
    expect(recapFromTranscript(claude, 's1')).toEqual({ text: 'new one', ts: Date.parse('2026-11-03T09:00:00Z') });
    expect(recapFromTranscript(claude, 'missing')).toBeUndefined();
  });
});
