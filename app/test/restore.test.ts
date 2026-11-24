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
  fs.utimesSync(file, 1, 1); // saved before a reboot
  const boot = 2000;
  expect(sessionsToRestore(file, restoreFile, boot).sessions).toEqual([{ tool: 'claude', sessionId: 'a', cwd: '/r', name: 'n' }]);
  saveOpenSessions(file, restoreFile, [], boot); // board starts after the reboot
  expect(sessionsToRestore(file, restoreFile, boot)).toEqual({ from: restoreFile, sessions: [{ tool: 'claude', sessionId: 'a', cwd: '/r', name: 'n' }] });
});

it('never replaces a saved list with an empty one (shutdown quits WezTerm first)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
  const file = path.join(dir, 'open.json');
  const restoreFile = path.join(dir, 'restore.json');
  saveOpenSessions(file, restoreFile, [card('a')], 0);
  saveOpenSessions(file, restoreFile, [], 0);
  expect(sessionsToRestore(file, restoreFile, Date.now() + 1000).sessions.map((s) => s.sessionId)).toEqual(['a']);
});

it('prefers a newer pre-boot open-sessions.json over an old restore.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
  const file = path.join(dir, 'open.json');
  const restoreFile = path.join(dir, 'restore.json');
  fs.writeFileSync(restoreFile, JSON.stringify([{ tool: 'claude', sessionId: 'old', cwd: '/r' }]));
  fs.utimesSync(restoreFile, 1, 1);
  saveOpenSessions(file, restoreFile, [card('new')], 0);
  expect(sessionsToRestore(file, restoreFile, Date.now() + 1000)).toMatchObject({ from: file, sessions: [{ sessionId: 'new' }] });
});

it('saves only names the user chose', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
  const file = path.join(dir, 'open.json');
  saveOpenSessions(file, path.join(dir, 'r.json'), [{ ...card('a'), nameSource: 'prompt' } as Card], 0);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0].name).toBeUndefined();
});

it('saves an empty list once the board saw no sessions long enough', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
  const file = path.join(dir, 'open.json');
  saveOpenSessions(file, path.join(dir, 'r.json'), [card('a')], 0);
  saveOpenSessions(file, path.join(dir, 'r.json'), [], 0, true);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([]);
});
