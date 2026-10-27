import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCards, type GitInfo, parseGitInfo } from './board';
import type { Names } from './names';
import type { Runner } from './run';
import { listClaudeSessions } from './sources/claudeAgents';
import { type ClaudeStatus, readClaudeStatus } from './sources/claudeStatus';
import type { OpencodeResult } from './sources/opencode';
import { type EventStore, firstPromptFromTranscript } from './sources/hookEvents';
import type { Board, Column, LiveSession } from './types';
import { claudeCommand, claudeTitle, codexCommand, opencodeCommand, resumeCommand, type Pane, paneForTty, ttysForPids, type WezTerm } from './wezterm';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AppDeps = {
  run: Runner;
  events: EventStore;
  names: Names;
  wezterm: WezTerm;
  home?: string;
  listSessions?: () => Promise<LiveSession[]>;
  listOpencode?: () => Promise<OpencodeResult>;
  statusDir?: string;
  createOpencode?: (directory: string, title: string) => Promise<string>;
  listCodex?: () => Promise<LiveSession[]>;
  demo?: boolean; // made-up sessions: actions are turned off
};

export class App {
  private sessions: LiveSession[] = [];
  private panes = new Map<string, Pane>(); // sessionId -> WezTerm pane
  private branches = new Map<string, GitInfo>(); // cwd -> git branch / worktree
  private since = new Map<string, { column: Column; since: number }>();
  private transcriptPrompts = new Map<string, string | undefined>();
  private sessionsError?: string;
  private opencodeError?: string;
  private codexError?: string;
  private pendingNames = new Map<number, string>(); // WezTerm pane id -> name for a Codex session not seen yet
  private opencodeTodayUsd?: number;
  private claudeStatus: ClaudeStatus = { perSession: new Map(), todayUsd: 0 };
  private weztermAvailable = false;
  private compacted = false;
  readonly home: string;

  constructor(private deps: AppDeps) {
    this.home = deps.home ?? os.homedir();
  }

  async poll(): Promise<void> {
    let claude = this.sessions.filter((s) => s.tool === 'claude');
    let opencode = this.sessions.filter((s) => s.tool === 'opencode');
    try {
      claude = await (this.deps.listSessions ?? (() => listClaudeSessions(this.deps.run)))();
      this.sessionsError = undefined;
    } catch (e) {
      this.sessionsError = `can't read sessions: ${(e as Error).message}`;
    }
    try {
      if (this.deps.listOpencode) {
        const r = await this.deps.listOpencode();
        opencode = r.sessions;
        this.opencodeTodayUsd = r.todayUsd;
      }
      this.opencodeError = undefined;
    } catch (e) {
      this.opencodeError = `can't read opencode sessions: ${(e as Error).message}`;
    }
    this.sessions = [...claude, ...opencode, ...this.sessions.filter((s) => s.tool === 'codex')];
    if (this.deps.statusDir) this.claudeStatus = readClaudeStatus(this.deps.statusDir);
    if (!this.compacted && !this.sessionsError) {
      this.deps.events.compact(new Set(this.sessions.map((s) => s.sessionId)));
      this.compacted = true;
    }
    this.deps.events.readNew();
    if (this.deps.listCodex) {
      try {
        const codex = await this.deps.listCodex();
        this.sessions = [...this.sessions.filter((s) => s.tool !== 'codex'), ...codex];
        this.codexError = undefined;
      } catch (e) {
        this.codexError = `can't read Codex sessions: ${(e as Error).message}`;
      }
    }
    await this.matchPanes();
    await this.readBranches();
  }

  private async matchPanes(): Promise<void> {
    this.weztermAvailable = await this.deps.wezterm.available();
    this.panes.clear();
    if (!this.weztermAvailable) return;
    let panes: Pane[];
    try {
      panes = await this.deps.wezterm.listPanes();
    } catch {
      return; // WezTerm installed but not running
    }
    const withPid = this.sessions.filter((s) => s.pid);
    const ttys = await ttysForPids(this.deps.run, withPid.map((s) => s.pid!));
    for (const s of withPid) {
      const tty = ttys.get(s.pid!);
      const pane = tty && paneForTty(panes, tty);
      if (pane) this.panes.set(s.sessionId, pane);
      const pending = pane && this.pendingNames.get(pane.pane_id);
      if (pending) {
        if (!this.deps.names.all()[s.sessionId]) this.deps.names.set(s.sessionId, pending);
        this.pendingNames.delete(pane!.pane_id);
      }
    }
  }

  private async readBranches(): Promise<void> {
    const cwds = [...new Set(this.sessions.map((s) => s.cwd))];
    const found = await Promise.all(
      cwds.map(async (cwd) => {
        try {
          const out = await this.deps.run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--abbrev-ref', 'HEAD', '--show-toplevel', '--git-dir', '--git-common-dir']);
          return [cwd, parseGitInfo(out)] as const;
        } catch {
          return [cwd, {}] as const; // not a git repo
        }
      }),
    );
    this.branches = new Map(found);
  }

  private firstPrompt(id: string): string | undefined {
    const fromHook = this.deps.events.firstPrompt(id);
    if (fromHook) return fromHook;
    if (!this.transcriptPrompts.has(id)) {
      this.transcriptPrompts.set(id, firstPromptFromTranscript(path.join(this.home, '.claude'), id));
    }
    return this.transcriptPrompts.get(id);
  }

  board(now = Date.now()): Board {
    const ended = this.deps.events.ended;
    const rawCards = buildCards({
      // A SessionEnd hides a session only if the live process started before it (resume keeps the sessionId).
      sessions: this.sessions.filter((s) => {
        const endTs = ended.get(s.sessionId);
        return endTs === undefined || (s.startedAt ?? 0) > endTs;
      }),
      lastEvent: (id) => this.deps.events.lastEvent(id),
      eventSince: (id) => this.deps.events.columnSince(id),
      firstPrompt: (id) => this.firstPrompt(id),
      names: this.deps.names.all(),
      weztermSessions: new Set(this.panes.keys()),
      branches: this.branches,
      titles: new Map([
        ...[...this.panes].flatMap(([id, p]) => {
          const t = claudeTitle(p.title);
          return t ? [[id, t] as [string, string]] : [];
        }),
        // opencode keeps real titles on the session itself
        ...this.sessions.filter((s) => s.tool === 'opencode' && s.name).map((s) => [s.sessionId, s.name!] as [string, string]),
      ]),
      since: this.since,
      now,
      home: this.home,
    });
    const cards = rawCards.map((c) => {
      const st = this.claudeStatus.perSession.get(c.sessionId);
      const s = this.sessions.find((x) => x.sessionId === c.sessionId);
      return {
        ...c,
        costUsd: c.tool === 'opencode' ? s?.costUsd : st?.costUsd,
        contextPct: st?.contextPct,
        model: c.tool === 'claude' ? st?.model : s?.model,
      };
    });
    const usage = {
      claude5h: this.claudeStatus.fiveHour,
      claude7d: this.claudeStatus.sevenDay,
      claudeTodayUsd: this.deps.statusDir ? this.claudeStatus.todayUsd : undefined,
      opencodeTodayUsd: this.opencodeTodayUsd,
    };
    const errors = [this.sessionsError, this.opencodeError, this.codexError, this.weztermAvailable ? undefined : 'WezTerm is not installed'];
    return { cards, usage, errors: errors.filter((e): e is string => !!e), weztermAvailable: this.weztermAvailable };
  }

  private card(id: string) {
    const card = this.board().cards.find((c) => c.sessionId === id);
    if (!card) throw new HttpError(404, 'session not found');
    return card;
  }

  async focus(id: string): Promise<{ message?: string }> {
    this.noDemo();
    const card = this.card(id);
    const pane = this.panes.get(id);
    if (pane) {
      await this.deps.wezterm.focus(pane.pane_id);
      return {};
    }
    if (card.kind === 'background') {
      await this.deps.wezterm.spawn(card.cwd, 'claude agents; exec zsh');
      return {};
    }
    const s = this.sessions.find((x) => x.sessionId === id);
    const tty = s?.pid ? (await ttysForPids(this.deps.run, [s.pid])).get(s.pid) : undefined;
    return { message: `Not in WezTerm. It runs on terminal device ${tty ?? 'unknown'}.` };
  }

  async close(id: string): Promise<void> {
    this.noDemo();
    const card = this.card(id);
    if (card.column !== 'idle') throw new HttpError(409, 'only Idle sessions can be closed');
    const pane = this.panes.get(id);
    if (pane) return this.deps.wezterm.kill(pane.pane_id);
    const pid = this.sessions.find((s) => s.sessionId === id)?.pid;
    if (!pid) throw new HttpError(409, 'background sessions cannot be closed from here');
    process.kill(pid, 'SIGTERM');
  }

  // Stops an Idle session running outside WezTerm and resumes it in a new WezTerm tab.
  async moveToWezterm(id: string, waitForExit = waitForPidExit): Promise<void> {
    this.noDemo();
    const card = this.card(id);
    if (card.column !== 'idle') throw new HttpError(409, 'only Idle sessions can be moved');
    if (card.inWezterm) throw new HttpError(409, 'already in WezTerm');
    const pid = this.sessions.find((s) => s.sessionId === id)?.pid;
    if (!pid) throw new HttpError(409, 'background sessions cannot be moved');
    process.kill(pid, 'SIGTERM');
    await waitForExit(pid);
    const cmd = card.tool === 'opencode' ? opencodeCommand(id) : card.tool === 'codex' ? codexCommand(id) : resumeCommand(id);
    await this.deps.wezterm.spawn(card.cwd, cmd);
  }

  private noDemo(): void {
    if (this.deps.demo) throw new HttpError(400, 'Demo mode: actions are turned off');
  }

  rename(id: string, name: string): void {
    this.deps.names.set(id, name);
  }

  repos(): string[] {
    const dev = path.join(this.home, 'dev');
    if (!fs.existsSync(dev)) return [];
    return fs
      .readdirSync(dev, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  }

  async newSession(repo: string, name?: string, tool: LiveSession['tool'] = 'claude'): Promise<void> {
    this.noDemo();
    if (!this.repos().includes(repo)) throw new HttpError(400, 'unknown repo');
    const dir = path.join(this.home, 'dev', repo);
    const title = name?.trim() || undefined;
    let cmd = claudeCommand(title);
    if (tool === 'codex') {
      // Codex has no name option and its session id is only known later: name the card once it shows up in the new pane
      const paneId = await this.deps.wezterm.spawn(dir, codexCommand());
      if (title) this.pendingNames.set(paneId, title);
      return;
    }
    if (tool === 'opencode') {
      // opencode has no name option: create the titled session through its service, then open it
      const id = title && this.deps.createOpencode ? await this.deps.createOpencode(dir, title) : undefined;
      cmd = opencodeCommand(id);
    }
    await this.deps.wezterm.spawn(dir, cmd);
  }
}

async function waitForPidExit(pid: number): Promise<void> {
  for (let i = 0; i < 25; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new HttpError(500, `session process ${pid} did not stop within 5 seconds`);
}
