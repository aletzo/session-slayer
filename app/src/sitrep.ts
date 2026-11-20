import type { Board, Card, Column } from './types';

const ORDER: Column[] = ['needs_input', 'working', 'idle'];
const LABEL: Record<Column, string> = { needs_input: 'needs input', working: 'working', idle: 'idle' };

export function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

// Markdown table cells: no pipes or line breaks.
const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function row(c: Card, now: number): string {
  const where = [c.repo, c.branch].filter(Boolean).join(' @ ');
  const said = c.lastReply ? `${c.lastReply.text} (${age(now - c.lastReply.ts)} ago)` : `prompt: ${c.firstPrompt?.slice(0, 200) ?? ''}`;
  return `| ${LABEL[c.column]} ${age(now - c.columnSince)} | ${cell(c.name)} | ${cell(c.ticket)} | ${c.tool} | ${cell(where)} | ${cell(said)} |`;
}

// Pure: one markdown table, sessions that need input first, then the longest in their column.
export function formatSitrep(board: Board, now = Date.now()): string {
  const cards = [...board.cards].sort((a, b) => ORDER.indexOf(a.column) - ORDER.indexOf(b.column) || a.columnSince - b.columnSince);
  const count = ORDER.map((c) => `${board.cards.filter((x) => x.column === c).length} ${LABEL[c]}`).join(', ');
  const lines = [
    `${board.cards.length} sessions: ${count}`,
    '',
    '| State | Session | Ticket | Tool | Repo @ branch | Last reply |',
    '|---|---|---|---|---|---|',
    ...cards.map((c) => row(c, now)),
  ];
  if (board.errors.length) lines.push('', ...board.errors.map((e) => `Error: ${e}`));
  return lines.join('\n');
}
