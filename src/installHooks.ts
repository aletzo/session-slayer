import fs from 'node:fs';

export const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

type HookEntry = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

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

export function installHooks(settingsFile: string, scriptPath: string): void {
  const text = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '{}';
  if (fs.existsSync(settingsFile)) fs.writeFileSync(`${settingsFile}.session-slayer.bak`, text);
  const next = addHooks(JSON.parse(text), scriptPath);
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2) + '\n');
}
