import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { HOOK_EVENTS, installHooks, uninstallHooks } from '../src/installHooks';

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
    const ours = after.hooks[event].filter((e: { hooks: { command?: string }[] }) => e.hooks.some((h) => h.command?.includes('session-slayer-hook.sh')));
    expect(ours).toHaveLength(1);
  }
  for (const [event, entries] of Object.entries(before.hooks ?? {})) {
    expect(after.hooks[event].slice(0, (entries as unknown[]).length)).toEqual(entries);
  }
  const { hooks: _a, ...restAfter } = after;
  const { hooks: _b, ...restBefore } = before;
  expect(restAfter).toEqual(restBefore);
  // the backup holds the original file, even after a second run
  expect(fs.readFileSync(`${f}.session-slayer.bak`, 'utf8')).toBe(original);
});

it('skips existing hooks without a command field', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'check' }] }] } }));
  installHooks(f, "/x/o'brien/session-slayer-hook.sh");
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  expect(after.hooks.Stop).toHaveLength(2);
  expect(after.hooks.Stop[1].hooks[0].command).toBe("sh '/x/o'\\''brien/session-slayer-hook.sh'");
});

it('moves hooks and status line from an older install folder, and reports no change on a re-run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
  const f = path.join(dir, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }));
  installHooks(f, '/old/session-slayer-hook.sh', '/old/session-slayer-statusline.sh');

  expect(installHooks(f, '/new/session-slayer-hook.sh', '/new/session-slayer-statusline.sh')).toBe(true);
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const event of HOOK_EVENTS) {
    expect(after.hooks[event]).toHaveLength(1);
    expect(after.hooks[event][0].hooks[0].command).toBe("sh '/new/session-slayer-hook.sh'");
  }
  expect(after.statusLine.command).toBe("sh '/new/session-slayer-statusline.sh' 'echo hi'");

  expect(installHooks(f, '/new/session-slayer-hook.sh', '/new/session-slayer-statusline.sh')).toBe(false);
});

it('uninstall removes only Session Slayer entries and restores the status line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayer-'));
  const f = path.join(dir, 'settings.json');
  const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, statusLine: { type: 'command', command: "echo it's me" } };
  fs.writeFileSync(f, JSON.stringify(original));
  installHooks(f, '/x/session-slayer-hook.sh', '/x/session-slayer-statusline.sh');
  const changed = JSON.parse(fs.readFileSync(f, 'utf8'));
  changed.permissions = { allow: ['Bash(ls)'] }; // a change made after setup
  fs.writeFileSync(f, JSON.stringify(changed));

  expect(uninstallHooks(f)).toBe(true);
  expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ ...original, permissions: { allow: ['Bash(ls)'] } });
  expect(uninstallHooks(f)).toBe(false);
});
