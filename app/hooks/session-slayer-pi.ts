// Session Slayer extension for pi (installed by `pnpm slayer install-hooks` as a link in ~/.pi/agent/extensions/).
// pi has no shell hooks: this writes the same lines as hooks/session-slayer-hook.sh to ~/.session-slayer/events.jsonl,
// with "tool":"pi" and the pid of this pi process, so the board finds the session without guessing its window.
// It must never break pi, so every write is wrapped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Content = { type?: string; text?: string };
type Message = { role?: string; content?: string | Content[] };

// Pure: the text of the last assistant message.
export function lastAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message;
    if (m?.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((c) => c?.type === 'text').map((c) => c.text ?? '').join('\n') : '';
    if (text.trim()) return text;
  }
  return undefined;
}

// Pure: one events.jsonl line.
export function eventLine(ts: number, pid: number, sessionId: string, cwd: string, event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, tool: 'pi', hook: { session_id: sessionId, cwd, pid, hook_event_name: event, ...extra } }) + '\n';
}

type Ctx = { cwd: string; model?: { id?: string }; sessionManager: { getSessionId(): string } };
type Api = { on(event: string, handler: (event: any, ctx: Ctx) => unknown): void };

export default function sessionSlayer(pi: Api): void {
  const file = path.join(process.env.SESSION_SLAYER_DIR ?? path.join(os.homedir(), '.session-slayer'), 'events.jsonl');
  const write = (ctx: Ctx, event: string, extra?: Record<string, unknown>) => {
    try {
      fs.appendFileSync(file, eventLine(Date.now(), process.pid, ctx.sessionManager.getSessionId(), ctx.cwd, event, { model: ctx.model?.id, ...extra }));
    } catch {
      // board not set up, or an ephemeral session: nothing to report
    }
  };
  pi.on('session_start', (_e, ctx) => write(ctx, 'SessionStart'));
  // `input` fires before pi checks the model or another extension handles the text, so a run may never start.
  // Keep the text and report the prompt only when the run starts: every working state then ends with a Stop.
  let prompt: string | undefined;
  pi.on('input', (e) => {
    prompt = e?.text;
  });
  pi.on('agent_start', (_e, ctx) => {
    write(ctx, 'UserPromptSubmit', { prompt });
    prompt = undefined;
  });
  pi.on('tool_execution_start', (e, ctx) => write(ctx, 'PreToolUse', { tool_name: e?.toolName }));
  pi.on('tool_execution_end', (e, ctx) => write(ctx, 'PostToolUse', { tool_name: e?.toolName }));
  pi.on('agent_end', (e, ctx) => write(ctx, 'Stop', { last_assistant_message: lastAssistantText(e?.messages) }));
  pi.on('session_shutdown', (_e, ctx) => write(ctx, 'SessionEnd'));
}
