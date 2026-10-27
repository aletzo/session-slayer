import fs from 'node:fs';
import path from 'node:path';

// Reads the status line JSON saved by hooks/session-slayer-statusline.sh, one file per session.
export type Limit = { pct: number; resetsAt: number }; // resetsAt in ms
export type ClaudeStatus = {
  perSession: Map<string, { costUsd?: number; contextPct?: number }>;
  fiveHour?: Limit;
  sevenDay?: Limit;
  todayUsd: number; // summed cost of sessions active since local midnight
};

type Raw = {
  cost?: { total_cost_usd?: number };
  context_window?: { used_percentage?: number | null };
  rate_limits?: Record<string, { used_percentage?: number; resets_at?: number } | undefined>;
};

function limit(r: Raw['rate_limits'], key: string, now: number): Limit | undefined {
  const w = r?.[key];
  if (typeof w?.used_percentage !== 'number' || !w.resets_at) return undefined;
  const resetsAt = w.resets_at * 1000;
  return resetsAt > now ? { pct: w.used_percentage, resetsAt } : undefined; // window already reset
}

export function readClaudeStatus(dir: string, now = Date.now()): ClaudeStatus {
  const status: ClaudeStatus = { perSession: new Map(), todayUsd: 0 };
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (!fs.existsSync(dir)) return status;
  let newest = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    let raw: Raw;
    let mtime: number;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue; // being written or not JSON
    }
    status.perSession.set(f.slice(0, -'.json'.length), {
      costUsd: raw.cost?.total_cost_usd,
      contextPct: raw.context_window?.used_percentage ?? undefined,
    });
    if (mtime >= midnight) status.todayUsd += raw.cost?.total_cost_usd ?? 0;
    // Plan limits are account-wide: take them from the most recently updated session.
    if (raw.rate_limits && mtime > newest) {
      newest = mtime;
      status.fiveHour = limit(raw.rate_limits, 'five_hour', now);
      status.sevenDay = limit(raw.rate_limits, 'seven_day', now);
    }
  }
  return status;
}
