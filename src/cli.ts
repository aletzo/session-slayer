import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './app';
import { installHooks } from './installHooks';
import { Names } from './names';
import { run } from './run';
import { createServer } from './server';
import { EventStore } from './sources/hookEvents';
import { listOpencodeSessions } from './sources/opencode';
import { WezTerm } from './wezterm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.SESSION_SLAYER_DIR ?? path.join(os.homedir(), '.session-slayer');
const PORT = Number(process.env.PORT ?? 4545);

async function serve(): Promise<void> {
  const app = new App({
    run,
    events: new EventStore(path.join(dataDir, 'events.jsonl')),
    names: new Names(path.join(dataDir, 'names.json')),
    wezterm: new WezTerm(run),
    listOpencode: () => listOpencodeSessions(run),
  });
  await app.poll();
  const server = createServer(app, path.join(root, 'dist', 'web'));
  server.listen(PORT, '127.0.0.1', () => console.log(`Session Slayer on http://127.0.0.1:${PORT}`));

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

const cmd = process.argv[2];
if (cmd === 'serve') {
  await serve();
} else if (cmd === 'install-hooks') {
  const settings = path.join(os.homedir(), '.claude', 'settings.json');
  installHooks(settings, path.join(root, 'hooks', 'session-slayer-hook.sh'));
  console.log(`Hooks added to ${settings} (backup: ${settings}.session-slayer.bak)`);
} else {
  console.log('Usage: pnpm slayer <serve|install-hooks>');
  process.exit(1);
}
