import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { saveOpenSessions, sessionsToRestore } from '../src/restore';
import type { Card } from '../src/types';

const card = (sessionId: string, kind: Card['kind'] = 'interactive') => ({ sessionId, kind, tool: 'claude', cwd: '/r', name: 'n', nameSource: 'user' }) as Card;

it('keeps the list from before a reboot until restore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
  const file = path.join(dir, 'open.json');
  const restoreFile = path.join(dir, 'restore.json');
  saveOpenSessions(file, restoreFile, [card('a'), card('bg', 'background')], 0);
  expect(sessionsToRestore(file, restoreFile, 0).sessions).toEqual([]); // no reboot since the save
  const boot = Date.now() + 1000; // a reboot after the save
  expect(sessionsToRestore(file, restoreFile, boot).sessions).toEqual([{ tool: 'claude', sessionId: 'a', cwd: '/r', name: 'n' }]);
  saveOpenSessions(file, restoreFile, [], boot); // board starts after the reboot
  expect(sessionsToRestore(file, restoreFile, boot)).toEqual({ from: restoreFile, sessions: [{ tool: 'claude', sessionId: 'a', cwd: '/r', name: 'n' }] });
});
