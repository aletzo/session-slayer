import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSitrep } from '../src/sitrep';
import { EventStore, parseLine, shortReply } from '../src/sources/hookEvents';
import { lastAssistantReply } from '../src/sources/opencode';
import type { Board, Card } from '../src/types';

const now = 10 * 3600_000;
const card = (o: Partial<Card>): Card => ({
  sessionId: 'x', name: 'n', nameSource: 'user', column: 'idle', lane: 'l', laneKind: 'repo', tags: [],
  columnSince: now, kind: 'interactive', tool: 'claude', cwd: '/', inWezterm: true, ...o,
});
const board = (cards: Card[]): Board => ({ cards, errors: [], weztermAvailable: true, defaultTool: 'claude', usage: {} });

describe('shortReply', () => {
  it('one line, cut at max', () => {
    expect(shortReply('a\n\n b  c')).toBe('a b c');
    expect(shortReply('x'.repeat(10), 5)).toBe('xx...');
    expect(shortReply('  ')).toBeUndefined();
  });
});

describe('last reply from hook events (Claude and Codex)', () => {
  it('keeps the newest Stop reply per session', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-')), 'events.jsonl');
    const l = (hook: object, ts: number, tool?: string) => JSON.stringify({ ts, tool, hook }) + '\n';
    fs.writeFileSync(file,
      l({ session_id: 'a', hook_event_name: 'Stop', last_assistant_message: 'first' }, 1) +
      l({ session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'go' }, 2) +
      l({ session_id: 'a', hook_event_name: 'Stop', last_assistant_message: 'Oi, ok?' }, 3) +
      l({ session_id: 'c', hook_event_name: 'Stop', last_assistant_message: 'codex done' }, 4, 'codex'));
    const s = new EventStore(file);
    s.readNew();
    expect(s.lastReply('a')).toEqual({ text: 'Oi, ok?', ts: 3 });
    expect(s.lastReply('c')).toEqual({ text: 'codex done', ts: 4 });
    expect(parseLine(l({ session_id: 'a', hook_event_name: 'PreToolUse', last_assistant_message: 'x' }, 1))?.reply).toBeUndefined();
  });
});

describe('lastAssistantReply (opencode)', () => {
  it('newest assistant message with text', () => {
    expect(lastAssistantReply([
      { type: 'assistant', time: { created: 1, completed: 2 }, content: [{ type: 'text', text: 'old' }] },
      { type: 'assistant', time: { created: 5 }, content: [{ type: 'tool', text: undefined }] },
      { type: 'idle', time: { created: 6 } },
      { type: 'assistant', time: { created: 3, completed: 4 }, content: [{ type: 'reasoning', text: 'hm' }, { type: 'text', text: 'new' }] },
    ])).toEqual({ text: 'new', ts: 4 });
    expect(lastAssistantReply([])).toBeUndefined();
    // Unknown shapes never throw: they only drop the reply.
    expect(lastAssistantReply([{ type: 'assistant' }, null, { type: 'assistant', content: 'x' }])).toBeUndefined();
    expect(lastAssistantReply({ data: [] })).toBeUndefined();
    expect(lastAssistantReply([{ type: 'assistant', content: [{ type: 'text', text: 'ok' }] }])).toEqual({ text: 'ok', ts: 0 });
  });
});

describe('formatSitrep', () => {
  it('needs input first, then oldest; reply or prompt; pipes escaped', () => {
    const out = formatSitrep(board([
      card({ sessionId: '1', name: 'idle one', columnSince: now - 3600_000, firstPrompt: 'do x' }),
      card({ sessionId: '2', name: 'ask | me', column: 'needs_input', ticket: 'PROJ-1', tool: 'opencode', lastReply: { text: 'Oi, ok?', ts: now - 120_000 } }),
    ]), now);
    const rows = out.split('\n').filter((r) => r.startsWith('| ') && !r.startsWith('| State'));
    expect(out.split('\n')[0]).toBe('2 sessions: 1 needs input, 0 working, 1 idle');
    expect(rows[0]).toBe('| needs input 0m | ask \\| me | PROJ-1 | opencode |  | Oi, ok? (2m ago) |');
    expect(rows[1]).toContain('| idle 1h | idle one |');
    expect(rows[1]).toContain('prompt: do x');
  });
});
