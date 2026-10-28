export type Column = 'working' | 'needs_input' | 'idle';

export type LiveSession = {
  tool: 'claude' | 'opencode' | 'codex';
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
};

export type NotificationKind = 'permission' | 'idle' | 'other';

export type SessionEvent = {
  sessionId: string;
  event: string;
  ts: number;
  toolName?: string;
  prompt?: string;
  notificationKind?: NotificationKind;
  asks?: boolean; // Stop: the last reply ends with a question
  tool?: 'claude' | 'codex';
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
};

export type Board = {
  cards: Card[];
  errors: string[];
  weztermAvailable: boolean;
  usage: {
    claude5h?: { pct: number; resetsAt: number };
    claude7d?: { pct: number; resetsAt: number };
    claudeTodayUsd?: number;
    codex5h?: { pct: number; resetsAt: number };
    codex7d?: { pct: number; resetsAt: number };
    opencodeTodayUsd?: number;
  };
};
