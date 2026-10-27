import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from './app';
import { Names } from './names';
import type { Runner } from './run';
import { EventStore } from './sources/hookEvents';
import type { LiveSession } from './types';
import { WezTerm } from './wezterm';

// Demo mode: made-up sessions for screenshots. Reads nothing from the real machine
// (no claude/opencode/codex, no ~/dev, no status files) and runs no real commands.

const MIN = 60_000;

type Demo = {
  id: string;
  tool: LiveSession['tool'];
  repo: string;
  sub?: string; // folder inside the repo (worktrees)
  title?: string; // Claude tab title or opencode title
  prompt?: string;
  column: 'working' | 'needs_input' | 'idle';
  minutes: number; // time in the current column
  branch: string;
  worktree?: boolean;
  model: string;
  cost?: number;
  ctx?: number;
  inWezterm?: boolean;
};

const SESSIONS: Demo[] = [
  { id: 'c1', tool: 'claude', repo: 'web-app', title: 'Add dark mode toggle', column: 'working', minutes: 4, branch: 'feat/dark-mode', model: 'Opus 5.5', cost: 1.84, ctx: 37 },
  { id: 'c2', tool: 'claude', repo: 'api', title: 'ABC-142 fix token refresh', column: 'needs_input', minutes: 2, branch: 'fix/ABC-142-token-refresh', model: 'Sonnet 5.5', cost: 0.62, ctx: 18 },
  { id: 'c3', tool: 'claude', repo: 'web-app', sub: '.claude/worktrees/checkout-form', title: 'Refactor checkout form', column: 'idle', minutes: 72, branch: 'refactor/checkout', worktree: true, model: 'Opus 5.5', cost: 3.1, ctx: 61 },
  { id: 'c4', tool: 'claude', repo: 'docs-site', prompt: 'Write the API reference for the orders endpoints', column: 'idle', minutes: 18, branch: 'main', model: 'Haiku 5.5', cost: 0.12, ctx: 9, inWezterm: false },
  { id: 'c5', tool: 'claude', repo: 'infra', title: 'Rotate log files', prompt: 'OPS-77: logs fill the disk, add rotation', column: 'working', minutes: 12, branch: 'ops/OPS-77-log-rotation', model: 'Sonnet 5.5', cost: 0.95, ctx: 24 },
  { id: 'o1', tool: 'opencode', repo: 'mobile-app', title: 'Bump dependencies', column: 'idle', minutes: 25, branch: 'chore/deps', model: 'glm-5.3-flash', cost: 0.04 },
  { id: 'o2', tool: 'opencode', repo: 'billing', title: 'ABC-150 rate limiter', column: 'working', minutes: 6, branch: 'feat/ABC-150-rate-limit', model: 'glm-5.3-flash', cost: 0.11 },
  { id: 'x1', tool: 'codex', repo: 'design-system', prompt: 'Fix broken links in the guides', column: 'needs_input', minutes: 1, branch: 'fix/links', model: 'gpt-5.5' },
  { id: 'x2', tool: 'codex', repo: 'analytics', prompt: 'Add unit tests for cart totals', column: 'idle', minutes: 40, branch: 'test/cart-totals', model: 'gpt-5.5' },
];

const LAST_EVENT = { working: 'PostToolUse', idle: 'Stop' } as const;

export function createDemoApp(now = Date.now()): App {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-slayer-demo-'));
  const data = path.join(home, '.session-slayer');
  const statusDir = path.join(data, 'status');
  fs.mkdirSync(statusDir, { recursive: true });
  for (const repo of ['web-app', 'api', 'docs-site', 'infra', 'mobile-app', 'billing', 'design-system', 'analytics']) fs.mkdirSync(path.join(home, 'dev', repo), { recursive: true });

  const cwd = (d: Demo) => path.join(home, 'dev', d.repo, d.sub ?? '');
  const pid = (i: number) => 40_000 + i;
  const tty = (i: number) => `ttys0${10 + i}`;

  // Hook events (Claude and Codex), written like the real hook script does.
  const lines: string[] = [];
  const add = (ts: number, hook: object, tool?: string) => lines.push(JSON.stringify({ ts, ...(tool ? { tool } : {}), hook }));
  for (const d of SESSIONS.filter((s) => s.tool !== 'opencode')) {
    const tool = d.tool === 'codex' ? 'codex' : undefined;
    const since = now - d.minutes * MIN;
    const base = { session_id: d.id, cwd: cwd(d), model: d.model };
    add(since - 30 * MIN, { ...base, hook_event_name: 'UserPromptSubmit', prompt: d.prompt ?? d.title ?? '' }, tool);
    // an earlier finished turn, so the current column starts exactly at `since`
    if (d.column === 'working') add(since - 20 * MIN, { ...base, hook_event_name: 'Stop' }, tool);
    if (d.column === 'needs_input') {
      add(since, d.tool === 'codex' ? { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash' } : { ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt' }, tool);
    } else {
      if (d.column === 'working') add(since, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'continue' }, tool);
      add(d.column === 'working' ? now - 10_000 : since, { ...base, hook_event_name: LAST_EVENT[d.column], tool_name: 'Edit' }, tool);
    }
  }
  fs.writeFileSync(path.join(data, 'events.jsonl'), lines.join('\n') + '\n');

  // Claude status line data: cost, context, model, plan limits.
  for (const d of SESSIONS.filter((s) => s.tool === 'claude')) {
    fs.writeFileSync(
      path.join(statusDir, `${d.id}.json`),
      JSON.stringify({
        session_id: d.id,
        model: { display_name: d.model },
        cost: { total_cost_usd: d.cost },
        context_window: { used_percentage: d.ctx },
        rate_limits: {
          five_hour: { used_percentage: 62, resets_at: Math.floor((now + 134 * MIN) / 1000) },
          seven_day: { used_percentage: 23, resets_at: Math.floor((now + 4 * 24 * 60 * MIN) / 1000) },
        },
      }),
    );
  }

  // Fake commands: WezTerm panes, terminal devices, git branches. Nothing real runs.
  const run: Runner = async (cmd, args) => {
    if (args[0] === '--version') return 'wezterm demo';
    if (args[0] === 'cli' && args[1] === 'list') {
      return JSON.stringify(
        SESSIONS.map((d, i) => ({ d, i }))
          .filter(({ d }) => d.inWezterm !== false)
          .map(({ d, i }) => ({ pane_id: i + 1, tty_name: `/dev/${tty(i)}`, title: d.tool === 'claude' && d.title ? `✳ ${d.title}` : d.tool })),
      );
    }
    if (cmd === 'ps') {
      const wanted = args[args.length - 1].split(',').map(Number);
      return SESSIONS.map((_, i) => i)
        .filter((i) => wanted.includes(pid(i)))
        .map((i) => `${pid(i)} ${tty(i)}`)
        .join('\n');
    }
    if (cmd === 'git') {
      const d = SESSIONS.find((s) => cwd(s) === args[1]);
      if (!d) throw new Error('not a git repo');
      const top = cwd(d);
      const common = path.join(home, 'dev', d.repo, '.git');
      return [d.branch, top, d.worktree ? path.join(common, 'worktrees', path.basename(top)) : common, common].join('\n');
    }
    return '';
  };

  const live = (tool: LiveSession['tool']) =>
    SESSIONS.map((d, i) => ({ d, i }))
      .filter(({ d }) => d.tool === tool)
      .map(({ d, i }) => ({
        tool,
        sessionId: d.id,
        pid: pid(i),
        cwd: cwd(d),
        kind: 'interactive' as const,
        startedAt: now - (d.minutes + 30) * MIN,
        ...(tool === 'claude' ? { status: d.column === 'working' ? 'busy' : 'idle' } : {}),
        ...(tool === 'opencode'
          ? {
              name: d.title,
              model: d.model,
              costUsd: d.cost,
              status: d.column === 'working' ? 'busy' : 'idle',
              columnSince: now - d.minutes * MIN,
            }
          : {}),
        ...(tool === 'codex' ? { model: d.model } : {}),
      }));

  return new App({
    run,
    events: new EventStore(path.join(data, 'events.jsonl')),
    names: new Names(path.join(data, 'names.json')),
    wezterm: new WezTerm(run, 'wezterm'),
    home,
    statusDir,
    listSessions: async () => live('claude'),
    listOpencode: async () => ({ sessions: live('opencode'), todayUsd: 0.37 }),
    listCodex: async () => live('codex'),
    demo: true,
  });
}
