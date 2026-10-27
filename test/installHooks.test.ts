import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { HOOK_EVENTS, installHooks } from '../src/installHooks';

it('adds entries, keeps existing hooks, no duplicates, writes a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
  const f = path.join(dir, 'settings.json');
  const original = fs.readFileSync(path.join(__dirname, 'settings.fixture.json'), 'utf8');
  fs.writeFileSync(f, original);

  installHooks(f, '/x/session-slayer-hook.sh');
  installHooks(f, '/x/session-slayer-hook.sh');

  const before = JSON.parse(original);
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const event of HOOK_EVENTS) {
    const ours = after.hooks[event].filter((e: { hooks: { command: string }[] }) => e.hooks.some((h) => h.command.includes('session-slayer-hook.sh')));
    expect(ours).toHaveLength(1);
  }
  for (const [event, entries] of Object.entries(before.hooks ?? {})) {
    expect(after.hooks[event].slice(0, (entries as unknown[]).length)).toEqual(entries);
  }
  const { hooks: _a, ...restAfter } = after;
  const { hooks: _b, ...restBefore } = before;
  expect(restAfter).toEqual(restBefore);
  expect(fs.existsSync(`${f}.session-slayer.bak`)).toBe(true);
});
