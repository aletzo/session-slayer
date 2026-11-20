import type { Spend } from './spend';

export type Column = 'working' | 'needs_input' | 'idle';

export type LiveSession = {
  tool: 'claude' | 'opencode' | 'codex' | 'pi';
  sessionId: string;
  pid?: number;
  cwd: string;
  name?: string;
  kind: 'interactive' | 'background';
  startedAt?: number;
  columnSince?: number; // when the session entered its current column, if the source knows
  costUsd?: number;
  model?: string;
  status?: string;
  state?: string;
  windowGuessed?: boolean; // paired to its window by folder and recency, not by process
  lastReply?: Reply; // opencode only: Claude and Codex replies come from hook events
};

// The agent's last reply, shortened, and when it was written.
export type Reply = { text: string; ts: number };

export type NotificationKind = 'permission' | 'idle' | 'other';

export type SessionEvent = {
  sessionId: string;
  event: string;
  ts: number;
  toolName?: string;
  prompt?: string;
  notificationKind?: NotificationKind;
  asks?: boolean; // Stop: the last reply ends with a question
  reply?: string; // Stop: the last reply, shortened
  tool?: 'claude' | 'codex' | 'pi';
  pid?: number; // pi: the process that wrote the event
  cwd?: string;
  model?: string;
};

export type Card = {
  sessionId: string;
  name: string;
  nameSource: 'user' | 'title' | 'prompt' | 'none';
  column: Column;
  lane: string;
  laneKind: 'ticket' | 'repo' | 'other';
  repo?: string;
  branch?: string;
  worktree?: string;
  ticket?: string;
  tags: string[];
  firstPrompt?: string;
  columnSince: number;
  kind: LiveSession['kind'];
  tool: LiveSession['tool'];
  cwd: string;
  inWezterm: boolean;
  costUsd?: number;
  contextPct?: number;
  model?: string;
  lastReply?: Reply;
};

export type Board = {
  cards: Card[];
  errors: string[];
  weztermAvailable: boolean;
  usage: {
    claude5h?: { pct: number; resetsAt: number };
    claude7d?: { pct: number; resetsAt: number };
    claudeSpend?: Spend;
    codex5h?: { pct: number; resetsAt: number };
    codex7d?: { pct: number; resetsAt: number };
    opencodeSpend?: Spend;
  };
};
