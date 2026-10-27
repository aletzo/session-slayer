export type Column = 'working' | 'needs_input' | 'idle';

export type LiveSession = {
  tool: 'claude' | 'opencode';
  sessionId: string;
  pid?: number;
  cwd: string;
  name?: string;
  kind: 'interactive' | 'background';
  startedAt?: number;
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
};

export type Card = {
  sessionId: string;
  name: string;
  nameSource: 'user' | 'title' | 'prompt' | 'none';
  column: Column;
  lane: string;
  repo?: string;
  branch?: string;
  worktree?: string;
  ticket?: string;
  tags: string[];
  firstPrompt?: string;
  columnSince: number;
  kind: LiveSession['kind'];
  cwd: string;
  inWezterm: boolean;
};

export type Board = {
  cards: Card[];
  errors: string[];
  weztermAvailable: boolean;
};
