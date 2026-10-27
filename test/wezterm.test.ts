import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { claudeCommand, paneForTty, ttysForPids, WezTerm } from '../src/wezterm';

function fakeRunner(outputs: Record<string, string> = {}) {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return outputs[args.slice(0, 2).join(' ')] ?? '';
  };
  return { run, calls };
}

describe('WezTerm', () => {
  it('focus and kill', async () => {
    const { run, calls } = fakeRunner();
    const w = new WezTerm(run, 'wezterm');
    await w.focus(7);
    await w.kill(8);
    expect(calls).toEqual([
      ['wezterm', 'cli', 'activate-pane', '--pane-id', '7'],
      ['open', '-a', 'WezTerm'],
      ['wezterm', 'cli', 'kill-pane', '--pane-id', '8'],
    ]);
  });
  it('spawn passes cwd and the zsh command as separate args', async () => {
    const { run, calls } = fakeRunner({ 'cli list': '[]', 'cli spawn': '42\n' });
    const id = await new WezTerm(run, 'wezterm').spawn('/h/dev/r', claudeCommand(`it's; rm -rf ~`));
    expect(id).toBe(42);
    expect(calls[1]).toEqual(['wezterm', 'cli', 'spawn', '--cwd', '/h/dev/r', '--', 'zsh', '-lic', `claude -n 'it'\\''s; rm -rf ~'; exec zsh`]);
  });
  it('a hostile name stays plain text in the shell', () => {
    const out = execFileSync('sh', ['-c', claudeCommand(`a'b; echo PWNED $(id)`).replace('claude', 'printf %s').replace('; exec zsh', '')]);
    expect(out.toString()).toBe(`-na'b; echo PWNED $(id)`);
  });
  it('no name -> plain claude', () => {
    expect(claudeCommand()).toBe('claude; exec zsh');
  });
});

it('ttysForPids and paneForTty', async () => {
  const run = async () => '  4100 ttys003\n  4200 ??\n';
  const map = await ttysForPids(run, [4100, 4200]);
  expect([...map]).toEqual([[4100, 'ttys003']]);
  expect(paneForTty([{ pane_id: 1, tty_name: '/dev/ttys003' }], 'ttys003')?.pane_id).toBe(1);
});
