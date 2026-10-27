// No Node imports: the web page uses this too.
export type LaneRef = { lane: string; laneKind: 'ticket' | 'repo' | 'other' };

const ORDER = { ticket: 0, repo: 1, other: 2 };

// Unique lanes: ticket projects first, then repos, then "other"; by name inside each group.
export function sortLanes(cards: LaneRef[]): string[] {
  const kinds = new Map(cards.map((c) => [c.lane, c.laneKind]));
  return [...kinds.keys()].sort((a, b) => ORDER[kinds.get(a)!] - ORDER[kinds.get(b)!] || a.localeCompare(b));
}
