import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { wrapStatusLine } from '../src/installHooks';
import { readClaudeStatus } from '../src/sources/claudeStatus';
import { type OcSession, sessionSpend } from '../src/sources/opencode';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
const wrapper = path.join(__dirname, '..', 'hooks', 'session-slayer-statusline.sh');

it('readClaudeStatus: per-session cost and context, limits from the newest file, expired windows dropped', () => {
  const dir = tmp();
  const now = Date.now();
  const future = now / 1000 + 3600;
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ cost: { total_cost_usd: 1.5 }, model: { display_name: 'Opus 5.5' }, context_window: { used_percentage: 40 }, rate_limits: { five_hour: { used_percentage: 10, resets_at: future } } }));
  fs.utimesSync(path.join(dir, 'a.json'), 1, 1);
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ cost: { total_cost_usd: 0.2 }, context_window: { used_percentage: null }, rate_limits: { five_hour: { used_percentage: 60, resets_at: future }, seven_day: { used_percentage: 5, resets_at: now / 1000 - 1 } } }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  const s = readClaudeStatus(dir, now);
  expect(s.perSession.get('a')).toEqual({ costUsd: 1.5, contextPct: 40, model: 'Opus 5.5' });
  expect(s.perSession.get('b')).toEqual({ costUsd: 0.2, contextPct: undefined, model: undefined });
  expect(s.fiveHour).toEqual({ pct: 60, resetsAt: future * 1000 });
  expect(s.sevenDay).toBeUndefined();
  expect(s.spend.today).toBeCloseTo(0.2); // a.json was last written in 1970
  expect(readClaudeStatus(path.join(dir, 'missing'), now).spend).toEqual({ today: 0, week: 0, month: 0 });
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

it('sessionSpend sums top-level sessions by day, Monday week and month', () => {
  const now = new Date(2026, 9, 29, 15).getTime(); // Thursday 29 Oct
  const at = (day: number) => new Date(2026, 9, day, 10).getTime();
  const s = (cost: number, updated: number, parentID?: string): OcSession => ({ id: 'x', cost, parentID, time: { created: 0, updated }, location: { directory: '/' } });
  const sessions = [s(1, at(29)), s(2, at(26)), s(4, at(25)), s(8, at(1)), s(16, new Date(2026, 8, 30).getTime()), s(32, at(29), 'p')];
  expect(sessionSpend(sessions, now)).toEqual({ today: 1, week: 3, month: 15 });
});
