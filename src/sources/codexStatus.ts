import fs from 'node:fs';
import path from 'node:path';
import type { Limit } from './claudeStatus';

// Codex writes its plan limits into its session files (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl):
// every `token_count` event has payload.rate_limits.primary (5 hours) and .secondary (week).
export type CodexLimits = { fiveHour?: Limit; week?: Limit };

type Window = { used_percent?: number; usedPercent?: number; resets_at?: number; resetsAt?: number } | undefined;

function limit(w: Window, now: number): Limit | undefined {
  const pct = w?.used_percent ?? w?.usedPercent;
  const resets = w?.resets_at ?? w?.resetsAt;
  if (typeof pct !== 'number' || !resets) return undefined;
  const resetsAt = resets < 1e12 ? resets * 1000 : resets; // seconds or ms
  return resetsAt > now ? { pct, resetsAt } : undefined; // window already reset
}

// Pure: the newest rate-limit snapshot in the text of a session file.
export function parseCodexLimits(text: string, now = Date.now()): CodexLimits | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('rate_limits')) continue;
    try {
      const r = JSON.parse(lines[i])?.payload?.rate_limits;
      if (r) return { fiveHour: limit(r.primary, now), week: limit(r.secondary, now) };
    } catch {
      // partial line
    }
  }
  return undefined;
}

// The most recently written session files, looking only at the last few day folders.
function newestFiles(sessionsDir: string, days = 7): string[] {
  const files: { f: string; m: number }[] = [];
  const now = new Date();
  for (let d = 0; d < days; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
    const dir = path.join(sessionsDir, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const f = path.join(dir, name);
      files.push({ f, m: fs.statSync(f).mtimeMs });
    }
  }
  return files.sort((a, b) => b.m - a.m).map((x) => x.f);
}

export function readCodexLimits(codexDir: string, now = Date.now()): CodexLimits | undefined {
  for (const file of newestFiles(path.join(codexDir, 'sessions')).slice(0, 5)) {
    // read only the end of the file: the newest snapshot is near the bottom
    const size = fs.statSync(file).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const limits = parseCodexLimits(buf.toString('utf8'), now);
    if (limits) return limits;
  }
  return undefined;
}
