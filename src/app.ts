import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCards } from './board';
import type { Names } from './names';
import type { Runner } from './run';
import { listClaudeSessions } from './sources/claudeAgents';
import { type EventStore, firstPromptFromTranscript } from './sources/hookEvents';
import type { Board, Column, LiveSession } from './types';
import { claudeCommand, claudeTitle, resumeCommand, type Pane, paneForTty, ttysForPids, type WezTerm } from './wezterm';

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
};

export class App {
  private sessions: LiveSession[] = [];
  private panes = new Map<string, Pane>(); // sessionId -> WezTerm pane
  private branches = new Map<string, string>(); // cwd -> git branch
  private since = new Map<string, { column: Column; since: number }>();
  private transcriptPrompts = new Map<string, string | undefined>();
  private sessionsError?: string;
  private weztermAvailable = false;
  private compacted = false;
  readonly home: string;

  constructor(private deps: AppDeps) {
    this.home = deps.home ?? os.homedir();
  }

  async poll(): Promise<void> {
    try {
      this.sessions = await (this.deps.listSessions ?? (() => listClaudeSessions(this.deps.run)))();
      this.sessionsError = undefined;
    } catch (e) {
      this.sessionsError = `can't read sessions: ${(e as Error).message}`;
    }
    if (!this.compacted && !this.sessionsError) {
      this.deps.events.compact(new Set(this.sessions.map((s) => s.sessionId)));
      this.compacted = true;
    }
    this.deps.events.readNew();
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
    }
  }

  private async readBranches(): Promise<void> {
    const cwds = [...new Set(this.sessions.map((s) => s.cwd))];
    const found = await Promise.all(
      cwds.map(async (cwd) => {
        try {
          return [cwd, (await this.deps.run('git', ['-C', cwd, 'branch', '--show-current'])).trim()] as const;
        } catch {
          return [cwd, ''] as const; // not a git repo
        }
      }),
    );
    this.branches = new Map(found.filter(([, b]) => b));
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
    const cards = buildCards({
      // A SessionEnd hides a session only if the live process started before it (resume keeps the sessionId).
      sessions: this.sessions.filter((s) => {
        const endTs = ended.get(s.sessionId);
        return endTs === undefined || (s.startedAt ?? 0) > endTs;
      }),
      lastEvent: (id) => this.deps.events.lastEvent(id),
      firstPrompt: (id) => this.firstPrompt(id),
      names: this.deps.names.all(),
      weztermSessions: new Set(this.panes.keys()),
      branches: this.branches,
      titles: new Map(
        [...this.panes].flatMap(([id, p]) => {
          const t = claudeTitle(p.title);
          return t ? [[id, t] as [string, string]] : [];
        }),
      ),
      since: this.since,
      now,
      home: this.home,
    });
    const errors = [this.sessionsError, this.weztermAvailable ? undefined : 'WezTerm is not installed'];
    return { cards, errors: errors.filter((e): e is string => !!e), weztermAvailable: this.weztermAvailable };
  }

  private card(id: string) {
    const card = this.board().cards.find((c) => c.sessionId === id);
    if (!card) throw new HttpError(404, 'session not found');
    return card;
  }

  async focus(id: string): Promise<{ message?: string }> {
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
    const card = this.card(id);
    if (card.column !== 'idle') throw new HttpError(409, 'only Idle sessions can be moved');
    if (card.inWezterm) throw new HttpError(409, 'already in WezTerm');
    const pid = this.sessions.find((s) => s.sessionId === id)?.pid;
    if (!pid) throw new HttpError(409, 'background sessions cannot be moved');
    process.kill(pid, 'SIGTERM');
    await waitForExit(pid);
    await this.deps.wezterm.spawn(card.cwd, resumeCommand(id));
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

  async newSession(repo: string, name?: string): Promise<void> {
    if (!this.repos().includes(repo)) throw new HttpError(400, 'unknown repo');
    await this.deps.wezterm.spawn(path.join(this.home, 'dev', repo), claudeCommand(name?.trim() || undefined));
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
