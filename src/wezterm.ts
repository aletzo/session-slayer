import fs from 'node:fs';
import type { Runner } from './run';

const APP_BIN = '/Applications/WezTerm.app/Contents/MacOS/wezterm';

export type Pane = { pane_id: number; tty_name?: string; cwd?: string; title?: string };

// Claude Code sets the tab title to "<status icon> <short summary>", e.g. "✳ Monorepo migration timeline".
export function claudeTitle(title: string | undefined): string | undefined {
  const m = title?.match(/^[^\p{L}\p{N}\s]+\s+(.+)$/u);
  const t = m?.[1].trim();
  return t && t !== 'Claude Code' ? t : undefined;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function claudeCommand(name?: string): string {
  return `${name ? `claude -n ${shellQuote(name)}` : 'claude'}; exec zsh`;
}

export function resumeCommand(sessionId: string): string {
  return `claude --resume ${shellQuote(sessionId)}; exec zsh`;
}

export class WezTerm {
  constructor(
    private run: Runner,
    readonly bin: string = fs.existsSync(APP_BIN) ? APP_BIN : 'wezterm',
  ) {}

  async available(): Promise<boolean> {
    try {
      await this.run(this.bin, ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async listPanes(): Promise<Pane[]> {
    return JSON.parse(await this.run(this.bin, ['cli', 'list', '--format', 'json']));
  }

  async focus(paneId: number): Promise<void> {
    await this.run(this.bin, ['cli', 'activate-pane', '--pane-id', String(paneId)]);
    await this.run('open', ['-a', 'WezTerm']);
  }

  async kill(paneId: number): Promise<void> {
    await this.run(this.bin, ['cli', 'kill-pane', '--pane-id', String(paneId)]);
  }

  // Starts WezTerm if needed and waits until its cli answers (up to 10 s).
  async ensureRunning(): Promise<void> {
    try {
      await this.listPanes();
      return;
    } catch {
      await this.run('open', ['-a', 'WezTerm']);
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        await this.listPanes();
        return;
      } catch {
        // not ready yet
      }
    }
    throw new Error('WezTerm did not start within 10 seconds');
  }

  async spawn(cwd: string, shellCommand: string): Promise<number> {
    await this.ensureRunning();
    const out = await this.run(this.bin, ['cli', 'spawn', '--cwd', cwd, '--', 'zsh', '-lic', shellCommand]);
    const paneId = Number(out.trim());
    await this.focus(paneId);
    return paneId;
  }
}

// pid -> tty name, e.g. "ttys003", in one ps call.
export async function ttysForPids(run: Runner, pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!pids.length) return map;
  let out = '';
  try {
    out = await run('ps', ['-o', 'pid=,tty=', '-p', pids.join(',')]);
  } catch (e) {
    // ps exits 1 when some pids are gone, but still prints the rest
    out = (e as { stdout?: string }).stdout ?? '';
  }
  for (const line of out.split('\n')) {
    const [pid, tty] = line.trim().split(/\s+/);
    if (pid && tty && tty !== '??') map.set(Number(pid), tty);
  }
  return map;
}

export function paneForTty(panes: Pane[], tty: string): Pane | undefined {
  return panes.find((p) => p.tty_name === `/dev/${tty}` || p.tty_name === tty);
}
