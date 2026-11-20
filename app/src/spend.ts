import fs from 'node:fs';

export type Spend = { today: number; week: number; month: number };

// Adds a cost to every period (local day, Monday-start week, calendar month) that `at` falls in.
export function addSpend(spend: Spend, cost: number, at: number, now: number): void {
  const d = new Date(now);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const week = new Date(day).setDate(day.getDate() - ((day.getDay() + 6) % 7));
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (at >= day.getTime()) spend.today += cost;
  if (at >= week) spend.week += cost;
  if (at >= month) spend.month += cost;
}

export const emptySpend = (): Spend => ({ today: 0, week: 0, month: 0 });

// Session id -> local day start (ms, as a string key) -> the session's running total cost seen on that day.
// Each day gets only the growth since the previous day, so a session that runs over several days is split correctly.
export type Ledger = Record<string, Record<string, number>>;
export type SessionTotal = { id: string; total: number; at: number }; // at = last active

const MAX_AGE_MS = 40 * 24 * 3600 * 1000;
const dayStart = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

// Records the totals in the ledger (mutates it), drops old sessions, and returns the spend per period.
export function ledgerSpend(ledger: Ledger, totals: SessionTotal[], now: number): Spend {
  for (const { id, total, at } of totals) (ledger[id] ??= {})[dayStart(at)] = total;
  const spend = emptySpend();
  for (const [id, days] of Object.entries(ledger)) {
    const sorted = Object.keys(days).map(Number).sort((a, b) => a - b);
    if (now - sorted[sorted.length - 1] > MAX_AGE_MS) {
      delete ledger[id];
      continue;
    }
    let prev = 0;
    for (const day of sorted) {
      // A total lower than the day before means the source restarted it (resume, revert): count it all as new.
      addSpend(spend, days[day] >= prev ? days[day] - prev : days[day], day, now);
      prev = days[day];
    }
  }
  return spend;
}

const lastJson = new Map<string, string>(); // file -> content on disk, to skip writes when nothing changed

export function readLedger(file?: string): Ledger {
  if (!file) return {};
  try {
    const json = fs.readFileSync(file, 'utf8');
    lastJson.set(file, json);
    return JSON.parse(json);
  } catch {
    return {}; // first run or broken file
  }
}

// Best effort: the board polls every 2 s, so a failed save must not stop it.
export function writeLedger(file: string | undefined, ledger: Ledger): void {
  if (!file) return;
  const json = JSON.stringify(ledger);
  if (lastJson.get(file) === json) return;
  try {
    fs.writeFileSync(`${file}.tmp`, json);
    fs.renameSync(`${file}.tmp`, file);
    lastJson.set(file, json);
  } catch {
    // laconic: no error shown on the board - add one if saves fail in practice
  }
}
