import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { parseCodexLimits, readCodexLimits } from '../src/sources/codexStatus';

const now = Date.now();
const future = Math.floor(now / 1000) + 3600;
const event = (rate_limits: object) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits } });

it('parseCodexLimits: newest snapshot wins; seconds or ms; expired windows dropped; camelCase accepted', () => {
  const text = [
    event({ primary: { used_percent: 10, resets_at: future } }),
    '{"type":"other"}',
    event({ primary: { used_percent: 40, resets_at: future }, secondary: { used_percent: 90, resets_at: Math.floor(now / 1000) - 5 } }),
    '{"partial',
  ].join('\n');
  expect(parseCodexLimits(text, now)).toEqual({ fiveHour: { pct: 40, resetsAt: future * 1000 }, week: undefined });
  expect(parseCodexLimits(event({ secondary: { usedPercent: 7, resetsAt: future * 1000 } }), now)).toEqual({ fiveHour: undefined, week: { pct: 7, resetsAt: future * 1000 } });
  expect(parseCodexLimits('{"type":"x"}', now)).toBeUndefined();
});

it("readCodexLimits: reads today's newest session file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-codex-'));
  const d = new Date();
  const day = path.join(dir, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), event({ primary: { used_percent: 55, resets_at: future } }) + '\n');
  expect(readCodexLimits(dir, now)?.fiveHour?.pct).toBe(55);
  expect(readCodexLimits(path.join(dir, 'missing'), now)).toBeUndefined();
});
