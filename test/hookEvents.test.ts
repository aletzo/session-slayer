import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventStore, parseLine } from '../src/sources/hookEvents';

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
});

it('a later event after SessionEnd clears it (resumed session)', () => {
  const f = tmp();
  fs.writeFileSync(f, line({ session_id: 'a', hook_event_name: 'SessionEnd' }, 5) + line({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }, 9));
  const s = new EventStore(f);
  s.readNew();
  expect(s.ended.has('a')).toBe(false);
});
