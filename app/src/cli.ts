import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './app';
import { createDemoApp } from './demo';
import { installCodexHooks, installHooks, installPiExtension, uninstallHooks, uninstallPiExtension } from './installHooks';
import { Names } from './names';
import { run } from './run';
import { createServer } from './server';
import { formatSitrep } from './sitrep';
import { type Board, type Card, TOOLS } from './types';
import { listCodexSessions } from './sources/codex';
import { listPiSessions } from './sources/pi';
import { EventStore } from './sources/hookEvents';
import { createOpencodeSession, listOpencodeSessions } from './sources/opencode';
import { restore, sessionsToRestore } from './restore';
import { WezTerm } from './wezterm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.SESSION_SLAYER_DIR ?? path.join(os.homedir(), '.session-slayer');
const configFile = path.join(dataDir, 'config.json');
const instanceFile = path.join(dataDir, 'instance.json');
const openSessionsFile = path.join(dataDir, 'open-sessions.json');
const restoreFile = path.join(dataDir, 'restore.json');
// Try BASE_PORT, then the next one, up to MAX_PORT_ATTEMPTS.
const BASE_PORT = 45300;
const MAX_PORT_ATTEMPTS = 100;

function readConfig(): { projectsDir?: string; defaultTool?: (typeof TOOLS)[number] } {
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
    listOpencode: () => listOpencodeSessions(run, undefined, path.join(dataDir, 'opencode-spend.json')),
    statusDir: path.join(dataDir, 'status'),
    claudeLedgerFile: path.join(dataDir, 'claude-spend.json'),
    createOpencode: (dir, title) => createOpencodeSession(dir, title),
    listCodex: () => listCodexSessions(run, events),
    listPi: () => listPiSessions(run, events),
    codexDir: path.join(os.homedir(), '.codex'),
    projectsDir: process.env.SESSION_SLAYER_PROJECTS_DIR ?? readConfig().projectsDir,
    openSessionsFile,
    restoreFile,
    defaultTool: () => readConfig().defaultTool ?? 'claude',
  });
  await app.poll();
  const server = createServer(app, path.join(root, 'dist', 'web'));
  const port = await listen(server);
  console.log(`Session Slayer on http://127.0.0.1:${port}`);
  if (!demo) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(instanceFile, JSON.stringify({ port, pid: process.pid, code: loadedCode, detached: process.env.SLAYER_DETACHED === '1' }));
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

// Which code a board runs: its app folder and the newest file time under src (server) and web (page).
// Taken at load, so a board records the code it loaded, not files changed during its slow first poll.
function codeStamp(): string {
  const times = ['src', 'web'].flatMap((d) => fs.readdirSync(path.join(root, d), { recursive: true }).map((f) => fs.statSync(path.join(root, d, String(f))).mtimeMs));
  return `${root}@${Math.max(...times)}`;
}
const loadedCode = codeStamp();

// A board started by `pnpm start` (detached: true) can be replaced. Any other board (launchd from SETUP.md, `pnpm serve`)
// is owned by something else: killing it can make its owner start it again next to ours.
type Instance = { port: number; pid: number; code?: string; detached?: boolean };
const ownerHint = 'It is not started by `pnpm start` (launchd or `pnpm serve`): restart it there, e.g. `launchctl kickstart -k gui/$(id -u)/com.session-slayer`.';

// A board counts as running only if its port answers: a crash or reboot can leave a stale instance.json.
async function runningInstance(): Promise<Instance | undefined> {
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
  if (inst && inst.code !== loadedCode) {
    if (inst.detached === undefined) console.log(`The board on port ${inst.port} runs other code. Restart it once with \`pnpm slayer restart\` (or under launchd if it runs there).`);
    else if (!inst.detached) console.log(`The board on port ${inst.port} runs other code. ${ownerHint}`);
    else {
      console.log(`The board on port ${inst.port} runs other code (${inst.code ?? 'an old version'}): restarting it`);
      await stopBoard(inst);
      inst = undefined;
    }
  }
  if (!inst) {
    // Build only for a new board: rebuilding under a live one swaps its page but keeps its old server.
    execFileSync(path.join(root, 'node_modules', '.bin', 'vite'), ['build'], { cwd: root, stdio: 'inherit' });
    fs.mkdirSync(dataDir, { recursive: true });
    const logFile = path.join(dataDir, 'board.log');
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'serve'], {
      detached: true,
      env: { ...process.env, SLAYER_DETACHED: '1' },
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

async function stopBoard(inst: Instance): Promise<void> {
  process.kill(inst.pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await runningInstance())) await new Promise((r) => setTimeout(r, 300));
  console.log(`Stopped the board on port ${inst.port}`);
}

const cmd = process.argv[2];
if (cmd === 'start') {
  await startDetached();
} else if (cmd === 'stop' || cmd === 'restart') {
  // Restart after an update: a running board keeps its old server code until it stops.
  const inst = await runningInstance();
  if (!inst) console.log('No board runs');
  // detached undefined: a board from before this field; the user asked to stop it, so do.
  else if (inst.detached === false) console.log(`Not stopped: the board on port ${inst.port}. ${ownerHint}`);
  else await stopBoard(inst);
  if (cmd === 'restart' && inst?.detached !== false) await startDetached();
} else if (cmd === 'send') {
  // pnpm slayer send <session id or part of its name> <message...>
  const [who, ...words] = process.argv.slice(3);
  const text = words.join(' ');
  const inst = await runningInstance();
  if (!inst || !who || !text) {
    console.log(inst ? 'Usage: pnpm slayer send <session id or name> <message>' : 'No Session Slayer board runs. Start it with: pnpm start');
    process.exit(1);
  }
  const base = `http://127.0.0.1:${inst.port}`;
  const board = (await (await fetch(`${base}/api/board`)).json()) as Board;
  // Exact id, then exact name, then part of a name: an exact match never counts as ambiguous.
  const w = who.toLowerCase();
  const tiers = [(c: Card) => c.sessionId === who, (c: Card) => c.name.toLowerCase() === w, (c: Card) => c.name.toLowerCase().includes(w)];
  const found = tiers.map((t) => board.cards.filter(t)).find((f) => f.length) ?? [];
  if (found.length !== 1) {
    console.log(found.length ? `"${who}" matches ${found.length} sessions: ${found.map((c) => c.name).join(', ')}` : `No session matches "${who}"`);
    process.exit(1);
  }
  const res = await fetch(`${base}/api/sessions/${found[0].sessionId}/send`, { method: 'POST', body: JSON.stringify({ text }) });
  if (!res.ok) {
    console.log(`Not sent: ${((await res.json()) as { error?: string }).error}`);
    process.exit(1);
  }
  console.log(`Sent to ${found[0].name} (${found[0].tool})`);
} else if (cmd === 'sitrep') {
  // Read-only: asks the running board, never starts one.
  const inst = await runningInstance();
  if (!inst) {
    console.log('No Session Slayer board runs. Start it with: pnpm start');
    process.exit(1);
  }
  const res = await fetch(`http://127.0.0.1:${inst.port}/api/board`, { signal: AbortSignal.timeout(5000) });
  console.log(formatSitrep(await res.json()));
} else if (cmd === 'serve') {
  await serve();
} else if (cmd === 'demo') {
  await serve(true);
} else if (cmd === 'default-tool') {
  // pnpm slayer default-tool [claude|opencode|codex|pi]: prints or sets the tool for new sessions
  const tool = process.argv[3] as (typeof TOOLS)[number] | undefined;
  if (tool && !TOOLS.find((t) => t === tool)) {
    console.log(`Unknown tool "${tool}". Use one of: ${TOOLS.join(', ')}`);
    process.exit(1);
  }
  if (tool) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ ...readConfig(), defaultTool: tool }, null, 2));
  }
  console.log(readConfig().defaultTool ?? 'claude');
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
  const piExtensions = path.join(os.homedir(), '.pi', 'agent', 'extensions');
  if (process.env.PATH?.split(':').some((d) => fs.existsSync(path.join(d, 'pi')))) {
    const changed = installPiExtension(piExtensions, path.join(root, 'hooks', 'session-slayer-pi.ts'));
    console.log(changed ? `pi extension linked in ${piExtensions}. Restart pi (or /reload) to load it.` : `pi extension already linked in ${piExtensions}`);
  } else {
    console.log('pi not found: skipped the pi extension.');
  }
} else if (cmd === 'restore') {
  const { from, sessions } = sessionsToRestore(openSessionsFile, restoreFile);
  const failed: typeof sessions = [];
  if (!sessions.length) {
    console.log('No sessions to restore.');
  } else {
    const wezterm = new WezTerm(run);
    for (const s of sessions) {
      try {
        console.log(`${s.tool} ${s.sessionId} -> pane ${await restore(wezterm, s)} (${s.cwd})`);
      } catch (e) {
        failed.push(s);
        console.log(`${s.tool} ${s.sessionId} failed: ${(e as Error).message}`);
      }
    }
  }
  // Restored once: not again. Failed sessions stay in restore.json for the next "restore".
  if (from === openSessionsFile) fs.writeFileSync(openSessionsFile, '[]');
  if (failed.length) fs.writeFileSync(restoreFile, JSON.stringify(failed, null, 2));
  else if (from) fs.rmSync(restoreFile, { force: true });
} else if (cmd === 'uninstall-hooks') {
  for (const [file, codex] of [[path.join(os.homedir(), '.claude', 'settings.json'), false], [path.join(os.homedir(), '.codex', 'hooks.json'), true]] as const) {
    console.log(uninstallHooks(file, codex) ? `Session Slayer hooks removed from ${file}` : `No Session Slayer hooks in ${file}`);
  }
  const piExtensions = path.join(os.homedir(), '.pi', 'agent', 'extensions');
  console.log(uninstallPiExtension(piExtensions) ? `pi extension removed from ${piExtensions}` : `No Session Slayer pi extension in ${piExtensions}`);
} else {
  console.log('Usage: pnpm slayer <start|stop|restart|sitrep|send <session> <message>|serve|demo|init --projects-dir <folder>|install-hooks|restore|default-tool [claude|opencode|codex|pi]|uninstall-hooks>');
  process.exit(1);
}
