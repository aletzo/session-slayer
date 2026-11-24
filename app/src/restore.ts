import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Card } from './types';
import { codexCommand, opencodeCommand, piCommand, resumeCommand, type WezTerm } from './wezterm';

// open-sessions.json: the interactive sessions seen by the last poll.
// restore.json: the open-sessions.json left by the last boot, kept until "restore" uses it.
export type Saved = Pick<Card, 'tool' | 'sessionId' | 'cwd'> & { name?: string };

export const bootTime = () => Date.now() - os.uptime() * 1000;

const mtimeOf = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
const read = (file: string): Saved[] => JSON.parse(fs.readFileSync(file, 'utf8'));

// Before the first save after a reboot, move the old list to restore.json, so the new (empty) list does not overwrite it.
// An empty list never replaces a non-empty one: on shutdown macOS quits WezTerm (and its sessions) before the board stops.
// allowEmpty: the board has seen no sessions long enough (not a shutdown race), so the user closed them.
export function saveOpenSessions(file: string, restoreFile: string, cards: Card[], boot = bootTime(), allowEmpty = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mtime = mtimeOf(file);
  if (mtime !== undefined && mtime < boot) fs.renameSync(file, restoreFile);
  const saved: Saved[] = cards.filter((c) => c.kind === 'interactive').map((c) => ({ tool: c.tool, sessionId: c.sessionId, cwd: c.cwd, name: c.nameSource === 'user' ? c.name : undefined }));
  if (!saved.length && !allowEmpty && fs.existsSync(file) && read(file).length) return;
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
}

// The list to restore: the newer of restore.json and an open-sessions.json from before this boot (no board ran since).
export function sessionsToRestore(file: string, restoreFile: string, boot = bootTime()): { from?: string; sessions: Saved[] } {
  const mtime = mtimeOf(file);
  const restoreMtime = mtimeOf(restoreFile);
  const fileOk = mtime !== undefined && mtime < boot;
  const from = fileOk && (restoreMtime === undefined || mtime > restoreMtime) ? file : restoreMtime !== undefined ? restoreFile : undefined;
  return { from, sessions: from ? read(from) : [] };
}

export async function restore(wezterm: WezTerm, s: Saved): Promise<number> {
  const cmd = s.tool === 'opencode' ? opencodeCommand(s.sessionId) : s.tool === 'codex' ? codexCommand(s.sessionId) : s.tool === 'pi' ? piCommand(s.sessionId) : resumeCommand(s.sessionId);
  const paneId = await wezterm.spawn(s.cwd, cmd);
  if (s.name) await wezterm.setTitle(paneId, s.name).catch(() => {}); // the pane is open: a title error is no failure
  return paneId;
}
