import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { wrapStatusLine } from '../src/installHooks';
import { readClaudeStatus } from '../src/sources/claudeStatus';
import { type OcSession, todayCost } from '../src/sources/opencode';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
const wrapper = path.join(__dirname, '..', 'hooks', 'session-slayer-statusline.sh');

it('readClaudeStatus: per-session cost and context, limits from the newest file, expired windows dropped', () => {
  const dir = tmp();
  const now = Date.now();
  const future = now / 1000 + 3600;
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ cost: { total_cost_usd: 1.5 }, context_window: { used_percentage: 40 }, rate_limits: { five_hour: { used_percentage: 10, resets_at: future } } }));
  fs.utimesSync(path.join(dir, 'a.json'), 1, 1);
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ cost: { total_cost_usd: 0.2 }, context_window: { used_percentage: null }, rate_limits: { five_hour: { used_percentage: 60, resets_at: future }, seven_day: { used_percentage: 5, resets_at: now / 1000 - 1 } } }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  const s = readClaudeStatus(dir, now);
  expect(s.perSession.get('a')).toEqual({ costUsd: 1.5, contextPct: 40 });
  expect(s.perSession.get('b')).toEqual({ costUsd: 0.2, contextPct: undefined });
  expect(s.fiveHour).toEqual({ pct: 60, resetsAt: future * 1000 });
  expect(s.sevenDay).toBeUndefined();
  expect(s.todayUsd).toBeCloseTo(0.2); // a.json was last written in 1970
  expect(readClaudeStatus(path.join(dir, 'missing'), now).todayUsd).toBe(0);
});

it('wrapStatusLine wraps once and keeps the original command', () => {
  const once = wrapStatusLine({ statusLine: { type: 'command', command: "bash /x/it's.sh", padding: 0 } }, '/w/session-slayer-statusline.sh');
  expect(once.statusLine).toEqual({ type: 'command', padding: 0, command: `sh '/w/session-slayer-statusline.sh' 'bash /x/it'\\''s.sh'` });
  expect(wrapStatusLine(once, '/w/session-slayer-statusline.sh')).toBe(once);
  expect(wrapStatusLine({}, '/w/session-slayer-statusline.sh').statusLine?.command).toBe(`sh '/w/session-slayer-statusline.sh'`);
});

it('status line wrapper saves the JSON and passes the same input to the original command', () => {
  const dir = tmp();
  const input = JSON.stringify({ session_id: 'abc-123', cost: { total_cost_usd: 2 } });
  const out = execFileSync('sh', [wrapper, 'cat; printf " [ok]"'], { input, env: { ...process.env, SESSION_SLAYER_DIR: dir } }).toString();
  expect(out).toBe(`${input} [ok]`);
  expect(fs.readFileSync(path.join(dir, 'status', 'abc-123.json'), 'utf8')).toBe(input);
});

it('todayCost sums top-level sessions used since midnight', () => {
  const now = new Date(2026, 9, 27, 15);
  const midnight = new Date(2026, 9, 27).getTime();
  const s = (cost: number, updated: number, parentID?: string): OcSession => ({ id: 'x', cost, parentID, time: { created: 0, updated }, location: { directory: '/' } });
  expect(todayCost([s(1, midnight + 1), s(2, midnight - 1), s(4, midnight + 5, 'p'), s(0.5, midnight + 9)], now)).toBe(1.5);
});
