import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Card } from './types';
import { codexCommand, opencodeCommand, piCommand, resumeCommand, type WezTerm } from './wezterm';

// open-sessions.json: the interactive sessions seen by the last poll.
// restore.json: the open-sessions.json left by the last boot, kept until "restore" uses it.
export type Saved = Pick<Card, 'tool' | 'sessionId' | 'cwd'> & { name?: string };

export const bootTime = () => Date.now() - os.uptime() * 1000;

// Before the first save after a reboot, move the old list to restore.json, so the new (empty) list does not overwrite it.
export function saveOpenSessions(file: string, restoreFile: string, cards: Card[], boot = bootTime()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
  if (mtime !== undefined && mtime < boot) fs.renameSync(file, restoreFile);
  const saved: Saved[] = cards.filter((c) => c.kind === 'interactive').map((c) => ({ tool: c.tool, sessionId: c.sessionId, cwd: c.cwd, name: c.nameSource === 'none' ? undefined : c.name }));
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
}

// The list to restore: restore.json, else an open-sessions.json from before this boot (no board ran since).
export function sessionsToRestore(file: string, restoreFile: string, boot = bootTime()): { from?: string; sessions: Saved[] } {
  const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
  const from = fs.existsSync(restoreFile) ? restoreFile : mtime !== undefined && mtime < boot ? file : undefined;
  return { from, sessions: from ? JSON.parse(fs.readFileSync(from, 'utf8')) : [] };
}

export async function restore(wezterm: WezTerm, s: Saved): Promise<number> {
  const cmd = s.tool === 'opencode' ? opencodeCommand(s.sessionId) : s.tool === 'codex' ? codexCommand(s.sessionId) : s.tool === 'pi' ? piCommand(s.sessionId) : resumeCommand(s.sessionId);
  const paneId = await wezterm.spawn(s.cwd, cmd);
  if (s.name) await wezterm.setTitle(paneId, s.name);
  return paneId;
}
