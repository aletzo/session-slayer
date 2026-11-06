import fs from 'node:fs';
import path from 'node:path';

export const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

type HookEntry = { matcher?: string; hooks: { type: string; command?: string; timeout?: number }[] };
type StatusLine = { type: string; command?: string } & Record<string, unknown>;
type Settings = { hooks?: Record<string, HookEntry[]>; statusLine?: StatusLine } & Record<string, unknown>;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Puts the Session Slayer wrapper in front of the existing status line command (once).
export function wrapStatusLine(settings: Settings, wrapperPath: string): Settings {
  const current = settings.statusLine;
  const ours = `sh ${shq(wrapperPath)}`;
  if (current?.command?.includes('session-slayer-statusline.sh')) {
    // Already wrapped: only move an old wrapper path (e.g. a former install folder) to this one.
    const command = current.command.replace(/^sh '(?:[^']|'\\'')*session-slayer-statusline\.sh'/, ours);
    return command === current.command ? settings : { ...settings, statusLine: { ...current, command } };
  }
  const command = `sh ${shq(wrapperPath)}${current?.command ? ` ${shq(current.command)}` : ''}`;
  return { ...settings, statusLine: { ...(current ?? {}), type: 'command', command } };
}

// Points existing Session Slayer hook entries at `command` (an older install may use another folder).
// Returns false when there is no such entry. Rebuilds the entries it changes, so the input stays untouched.
function repoint(entries: HookEntry[], command: string): boolean {
  let found = false;
  entries.forEach((e, i) => {
    if (!e.hooks?.some((h) => h.command?.includes('session-slayer-hook.sh'))) return;
    found = true;
    entries[i] = { ...e, hooks: e.hooks.map((h) => (h.command?.includes('session-slayer-hook.sh') ? { ...h, command } : h)) };
  });
  return found;
}

export function addHooks(settings: Settings, scriptPath: string): Settings {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    const entries = [...(hooks[event] ?? [])];
    const command = `sh ${shq(scriptPath)}`;
    if (!repoint(entries, command)) {
      entries.push({
        ...(TOOL_EVENTS.has(event) ? { matcher: '*' } : {}),
        hooks: [{ type: 'command', command, timeout: 5 }],
      });
    }
    hooks[event] = entries;
  }
  return { ...settings, hooks };
}

// Returns true when the settings file changed.
export function installHooks(settingsFile: string, scriptPath: string, statusLineWrapper?: string): boolean {
  const text = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '{}';
  // Keep the first backup: a re-run must not replace the user's original file.
  if (fs.existsSync(settingsFile) && !fs.existsSync(`${settingsFile}.session-slayer.bak`)) fs.writeFileSync(`${settingsFile}.session-slayer.bak`, text);
  let next = addHooks(JSON.parse(text), scriptPath);
  if (statusLineWrapper) next = wrapStatusLine(next, statusLineWrapper);
  const out = JSON.stringify(next, null, 2) + '\n';
  if (JSON.stringify(JSON.parse(text)) === JSON.stringify(next)) return false;
  fs.writeFileSync(settingsFile, out);
  return true;
}

export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'];

// Codex reads Claude-style hooks from ~/.codex/hooks.json. Codex asks you to review new hooks once.
export function addCodexHooks(config: Settings, scriptPath: string): Settings {
  const hooks = { ...(config.hooks ?? {}) };
  for (const event of CODEX_HOOK_EVENTS) {
    const entries = [...(hooks[event] ?? [])];
    const command = `sh ${shq(scriptPath)} codex`;
    if (!repoint(entries, command)) {
      entries.push({
        ...(TOOL_EVENTS.has(event) || event === 'PermissionRequest' ? { matcher: '*' } : {}),
        hooks: [{ type: 'command', command, timeout: 5 }],
      });
    }
    hooks[event] = entries;
  }
  return { ...config, hooks };
}

// Returns true when the hooks file changed.
export function installCodexHooks(hooksFile: string, scriptPath: string): boolean {
  const text = fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile, 'utf8') : '{}';
  if (fs.existsSync(hooksFile) && !fs.existsSync(`${hooksFile}.session-slayer.bak`)) fs.writeFileSync(`${hooksFile}.session-slayer.bak`, text);
  const next = addCodexHooks(JSON.parse(text), scriptPath);
  if (JSON.stringify(JSON.parse(text)) === JSON.stringify(next)) return false;
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  fs.writeFileSync(hooksFile, JSON.stringify(next, null, 2) + '\n');
  return true;
}

const unshq = (s: string) => s.slice(1, -1).replace(/'\\''/g, "'");
const isOurs = (h: { command?: string }) => !!h.command?.includes('session-slayer-hook.sh');

// Removes only the Session Slayer entries; everything else in the file stays as it is.
function dropHooks(hooks: Record<string, HookEntry[]> = {}): Record<string, HookEntry[]> {
  const out: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = entries
      .map((e) => (e.hooks?.some(isOurs) ? { ...e, hooks: e.hooks.filter((h) => !isOurs(h)) } : e))
      .filter((e) => !Array.isArray(e.hooks) || e.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}

export function removeHooks(settings: Settings): Settings {
  const { hooks, statusLine, ...rest } = settings;
  const next: Settings = { ...rest };
  const dropped = dropHooks(hooks);
  if (Object.keys(dropped).length) next.hooks = dropped;
  const m = statusLine?.command?.match(/^sh '(?:[^']|'\\'')*session-slayer-statusline\.sh'(?: ('(?:[^']|'\\'')*'))?$/);
  if (!m) {
    if (statusLine) next.statusLine = statusLine;
  } else if (m[1]) {
    next.statusLine = { ...statusLine!, command: unshq(m[1]) };
  }
  return next;
}

// Returns true when the file changed.
export function uninstallHooks(file: string, codex = false): boolean {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const before = JSON.parse(text) as Settings;
  const next = codex ? { ...before, hooks: dropHooks(before.hooks) } : removeHooks(before);
  if (JSON.stringify(before) === JSON.stringify(next)) return false;
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return true;
}
