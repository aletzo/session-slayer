export type Spend = { today: number; week: number; month: number };

// Adds a session's cost to every period (local day, Monday-start week, calendar month) it was last active in.
export function addSpend(spend: Spend, cost: number, lastActive: number, now: number): void {
  const d = new Date(now);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const week = new Date(day).setDate(day.getDate() - ((day.getDay() + 6) % 7));
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  if (lastActive >= day.getTime()) spend.today += cost;
  if (lastActive >= week) spend.week += cost;
  if (lastActive >= month) spend.month += cost;
}

export const emptySpend = (): Spend => ({ today: 0, week: 0, month: 0 });
