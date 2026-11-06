import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './app';
import { createDemoApp } from './demo';
import { installCodexHooks, installHooks, uninstallHooks } from './installHooks';
import { Names } from './names';
import { run } from './run';
import { createServer } from './server';
import { listCodexSessions } from './sources/codex';
import { EventStore } from './sources/hookEvents';
import { createOpencodeSession, listOpencodeSessions } from './sources/opencode';
import { WezTerm } from './wezterm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.SESSION_SLAYER_DIR ?? path.join(os.homedir(), '.session-slayer');
const configFile = path.join(dataDir, 'config.json');
const instanceFile = path.join(dataDir, 'instance.json');
// Try BASE_PORT, then the next one, up to MAX_PORT_ATTEMPTS.
const BASE_PORT = 45300;
const MAX_PORT_ATTEMPTS = 100;

function readConfig(): { projectsDir?: string } {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return {};
  }
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  const fixed = process.env.PORT ? Number(process.env.PORT) : undefined;
  return new Promise((resolve, reject) => {
    let attempt = 0;
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && fixed === undefined && ++attempt < MAX_PORT_ATTEMPTS) server.listen(BASE_PORT + attempt, '127.0.0.1');
      else reject(err);
    });
    server.once('listening', () => resolve((server.address() as AddressInfo).port));
    server.listen(fixed ?? BASE_PORT, '127.0.0.1');
  });
}

async function serve(demo = false): Promise<void> {
  const events = new EventStore(path.join(dataDir, 'events.jsonl'));
  const app = demo ? createDemoApp() : new App({
    run,
    events,
    names: new Names(path.join(dataDir, 'names.json')),
    wezterm: new WezTerm(run),
    listOpencode: () => listOpencodeSessions(run),
    statusDir: path.join(dataDir, 'status'),
    createOpencode: (dir, title) => createOpencodeSession(dir, title),
    listCodex: () => listCodexSessions(run, events),
    codexDir: path.join(os.homedir(), '.codex'),
    projectsDir: process.env.SESSION_SLAYER_PROJECTS_DIR ?? readConfig().projectsDir,
  });
  await app.poll();
  const server = createServer(app, path.join(root, 'dist', 'web'));
  const port = await listen(server);
  console.log(`Session Slayer on http://127.0.0.1:${port}`);
  if (!demo) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(instanceFile, JSON.stringify({ port, pid: process.pid }));
    const cleanup = () => {
      try {
        if (JSON.parse(fs.readFileSync(instanceFile, 'utf8')).pid === process.pid) fs.unlinkSync(instanceFile);
      } catch {}
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  }

  // Poll every 2 s; a running poll is never doubled. Time-in-column labels are rendered by the page.
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await app.poll();
      server.broadcast();
    } finally {
      busy = false;
    }
  }, 2000);
}

// A board counts as running only if its port answers: a crash or reboot can leave a stale instance.json.
async function runningInstance(): Promise<{ port: number; pid: number } | undefined> {
  try {
    const inst = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
    const res = await fetch(`http://127.0.0.1:${inst.port}/api/repos`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? inst : undefined;
  } catch {
    return undefined;
  }
}

// Starts `serve` in its own process group so the board outlives the shell (or agent session) that started it.
async function startDetached(): Promise<void> {
  let inst = await runningInstance();
  if (!inst) {
    // Build only for a new board: rebuilding under a live one swaps its page but keeps its old server.
    execFileSync(path.join(root, 'node_modules', '.bin', 'vite'), ['build'], { cwd: root, stdio: 'inherit' });
    fs.mkdirSync(dataDir, { recursive: true });
    const logFile = path.join(dataDir, 'board.log');
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'serve'], {
      detached: true,
      stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    });
    let exited = false;
    child.on('exit', () => (exited = true));
    child.unref();
    // The first poll runs many slow tools, so wait until the board answers or dies, with a 2 minute cap.
    const deadline = Date.now() + 120_000;
    while (!exited && Date.now() < deadline && !(inst = await runningInstance())) await new Promise((r) => setTimeout(r, 300));
    if (!inst) {
      if (!exited) process.kill(-child.pid!, 'SIGTERM');
      console.log(`Board did not start. See ${logFile}`);
      process.exit(1);
    }
  }
  console.log(`Session Slayer on http://127.0.0.1:${inst.port}`);
}

const cmd = process.argv[2];
if (cmd === 'start') {
  await startDetached();
} else if (cmd === 'serve') {
  await serve();
} else if (cmd === 'demo') {
  await serve(true);
} else if (cmd === 'init' || cmd === 'install-hooks') {
  if (cmd === 'init') {
    const i = process.argv.indexOf('--projects-dir');
    const dir = i > 0 ? process.argv[i + 1] : undefined;
    if (!dir) {
      console.log('Usage: pnpm slayer init --projects-dir <folder>');
      process.exit(1);
    }
    const projectsDir = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.statSync(projectsDir, { throwIfNoEntry: false })?.isDirectory()) {
      console.log(`Not a folder: ${projectsDir}`);
      process.exit(1);
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ ...readConfig(), projectsDir }, null, 2));
    console.log(`Projects folder saved to ${configFile}: ${projectsDir}`);
  }
  const settings = path.join(os.homedir(), '.claude', 'settings.json');
  const changed = installHooks(
    settings,
    path.join(root, 'hooks', 'session-slayer-hook.sh'),
    path.join(root, 'hooks', 'session-slayer-statusline.sh'),
  );
  console.log(changed ? `Hooks updated in ${settings} (backup: ${settings}.session-slayer.bak)` : `Hooks already up to date in ${settings}`);
  const codexHooks = path.join(os.homedir(), '.codex', 'hooks.json');
  const hasCodex = process.env.PATH?.split(':').some((d) => fs.existsSync(path.join(d, 'codex')));
  if (hasCodex) {
    if (installCodexHooks(codexHooks, path.join(root, 'hooks', 'session-slayer-hook.sh'))) {
      console.log(`Codex hooks updated in ${codexHooks}. Codex asks you to review them once on its next start.`);
    } else {
      console.log(`Codex hooks already up to date in ${codexHooks}`);
    }
  } else {
    console.log('Codex not found: skipped Codex hooks.');
  }
} else if (cmd === 'uninstall-hooks') {
  for (const [file, codex] of [[path.join(os.homedir(), '.claude', 'settings.json'), false], [path.join(os.homedir(), '.codex', 'hooks.json'), true]] as const) {
    console.log(uninstallHooks(file, codex) ? `Session Slayer hooks removed from ${file}` : `No Session Slayer hooks in ${file}`);
  }
} else {
  console.log('Usage: pnpm slayer <start|serve|demo|init --projects-dir <folder>|install-hooks|uninstall-hooks>');
  process.exit(1);
}
