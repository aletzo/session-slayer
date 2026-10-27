import fs from 'node:fs';
import path from 'node:path';
import { isRelevant } from '../board';
import type { NotificationKind, SessionEvent } from '../types';

// One line as written by hooks/session-slayer-hook.sh: {"ts": <ms>, "hook": <Claude hook input>}.
type Line = {
  ts: number;
  hook: {
    session_id?: string;
    hook_event_name?: string;
    tool_name?: string;
    prompt?: string;
    notification_type?: string;
    message?: string;
  };
};

function notificationKind(h: Line['hook']): NotificationKind {
  const type = h.notification_type ?? '';
  if (type === 'permission_prompt' || /permission/i.test(h.message ?? '')) return 'permission';
  if (type === 'idle_prompt' || /waiting for your input/i.test(h.message ?? '')) return 'idle';
  return 'other';
}

export function parseLine(line: string): SessionEvent | null {
  let l: Line;
  try {
    l = JSON.parse(line);
  } catch {
    return null;
  }
  const h = l?.hook;
  if (!h?.session_id || !h.hook_event_name) return null;
  return {
    sessionId: h.session_id,
    event: h.hook_event_name,
    ts: l.ts,
    toolName: h.tool_name,
    prompt: h.prompt,
    notificationKind: h.hook_event_name === 'Notification' ? notificationKind(h) : undefined,
  };
}

export class EventStore {
  private offset = 0;
  private partial = '';
  private last = new Map<string, SessionEvent>();
  private first = new Map<string, string>();
  readonly ended = new Map<string, number>(); // sessionId -> SessionEnd ts

  constructor(readonly file: string) {}

  // Keeps only lines of live sessions. Called once at start.
  compact(liveIds: Set<string>): void {
    if (!fs.existsSync(this.file)) return;
    const kept = fs
      .readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => {
        const e = parseLine(line);
        return e && liveIds.has(e.sessionId);
      });
    fs.writeFileSync(this.file, kept.length ? kept.join('\n') + '\n' : '');
    this.offset = 0;
    this.partial = '';
  }

  // Reads lines added since the last call. Returns true when something changed.
  readNew(): boolean {
    if (!fs.existsSync(this.file)) return false;
    const size = fs.statSync(this.file).size;
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return false;

    const fd = fs.openSync(this.file, 'r');
    const buf = Buffer.alloc(size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;

    const lines = (this.partial + buf.toString('utf8')).split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const e = parseLine(line);
      if (!e) {
        console.warn(`[events] skipped bad line: ${line.slice(0, 120)}`);
        continue;
      }
      this.add(e);
    }
    return true;
  }

  private add(e: SessionEvent): void {
    if (e.event === 'SessionEnd') this.ended.set(e.sessionId, e.ts);
    else this.ended.delete(e.sessionId); // resumed: same sessionId comes back
    if (e.event === 'UserPromptSubmit' && e.prompt && !this.first.has(e.sessionId)) {
      this.first.set(e.sessionId, e.prompt);
    }
    if (isRelevant(e)) this.last.set(e.sessionId, e);
  }

  lastEvent(id: string): SessionEvent | undefined {
    return this.last.get(id);
  }

  firstPrompt(id: string): string | undefined {
    return this.first.get(id);
  }
}

// Fallback for sessions without a UserPromptSubmit event: first user text in the transcript.
export function firstPromptFromTranscript(claudeDir: string, sessionId: string): string | undefined {
  const projects = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projects)) return undefined;
  for (const dir of fs.readdirSync(projects)) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      try {
        const l = JSON.parse(line);
        if (l.type !== 'user' || l.isMeta) continue;
        const c = l.message?.content;
        const text = typeof c === 'string' ? c : c?.find?.((p: { type: string }) => p.type === 'text')?.text;
        if (text && !text.startsWith('<')) return text;
      } catch {
        // partial last line or not JSON
      }
    }
  }
  return undefined;
}
