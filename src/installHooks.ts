import fs from 'node:fs';
import path from 'node:path';

export const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };
type StatusLine = { type: string; command: string } & Record<string, unknown>;
type Settings = { hooks?: Record<string, HookEntry[]>; statusLine?: StatusLine } & Record<string, unknown>;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Puts the Session Slayer wrapper in front of the existing status line command (once).
export function wrapStatusLine(settings: Settings, wrapperPath: string): Settings {
  const current = settings.statusLine;
  if (current?.command.includes('session-slayer-statusline.sh')) return settings;
  const command = `sh ${shq(wrapperPath)}${current?.command ? ` ${shq(current.command)}` : ''}`;
  return { ...settings, statusLine: { ...(current ?? {}), type: 'command', command } };
}

export function addHooks(settings: Settings, scriptPath: string): Settings {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    const entries = [...(hooks[event] ?? [])];
    const present = entries.some((e) => e.hooks?.some((h) => h.command.includes('session-slayer-hook.sh')));
    if (!present) {
      entries.push({
        ...(TOOL_EVENTS.has(event) ? { matcher: '*' } : {}),
        hooks: [{ type: 'command', command: `sh '${scriptPath}'`, timeout: 5 }],
      });
    }
    hooks[event] = entries;
  }
  return { ...settings, hooks };
}

export function installHooks(settingsFile: string, scriptPath: string, statusLineWrapper?: string): void {
  const text = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '{}';
  if (fs.existsSync(settingsFile)) fs.writeFileSync(`${settingsFile}.session-slayer.bak`, text);
  let next = addHooks(JSON.parse(text), scriptPath);
  if (statusLineWrapper) next = wrapStatusLine(next, statusLineWrapper);
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2) + '\n');
}

export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'];

// Codex reads Claude-style hooks from ~/.codex/hooks.json. Codex asks you to review new hooks once.
export function addCodexHooks(config: Settings, scriptPath: string): Settings {
  const hooks = { ...(config.hooks ?? {}) };
  for (const event of CODEX_HOOK_EVENTS) {
    const entries = [...(hooks[event] ?? [])];
    if (!entries.some((e) => e.hooks?.some((h) => h.command.includes('session-slayer-hook.sh')))) {
      entries.push({
        ...(TOOL_EVENTS.has(event) || event === 'PermissionRequest' ? { matcher: '*' } : {}),
        hooks: [{ type: 'command', command: `sh ${shq(scriptPath)} codex`, timeout: 5 }],
      });
    }
    hooks[event] = entries;
  }
  return { ...config, hooks };
}

export function installCodexHooks(hooksFile: string, scriptPath: string): void {
  const text = fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile, 'utf8') : '{}';
  if (fs.existsSync(hooksFile)) fs.writeFileSync(`${hooksFile}.session-slayer.bak`, text);
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, JSON.stringify(addCodexHooks(JSON.parse(text), scriptPath), null, 2) + '\n');
}
