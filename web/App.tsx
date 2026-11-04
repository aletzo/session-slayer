import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sortLanes } from '../src/lanes';
import type { Spend } from '../src/spend';
import type { Board, Card, Column } from '../src/types';

const COLUMNS: { key: Column; title: string }[] = [
  { key: 'working', title: 'Working' },
  { key: 'needs_input', title: 'Needs input' },
  { key: 'idle', title: 'Idle' },
];

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private window or blocked storage
  }
}

async function api(method: string, url: string, body?: unknown): Promise<Record<string, string>> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function age(since: number, now: number): string {
  const m = Math.floor((now - since) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

// One picture per session count: 00 to 20, then 21_plus.
// Light theme uses the horde_light set.
function hordeImage(count: number, light: boolean): string {
  const n = count > 20 ? '21_plus' : String(count).padStart(2, '0');
  return light ? `/horde_light/horde_${n}.jpg` : `/horde/horde_${n}.jpg`;
}

// Follows the system theme while the page is open.
// A background tab can sleep through the 'change' event (the CSS still switches), so check again when the tab wakes.
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function useSystemDark(): boolean {
  const [dark, setDark] = useState(darkQuery.matches);
  useEffect(() => {
    const sync = () => setDark(darkQuery.matches);
    darkQuery.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('pageshow', sync);
    return () => {
      darkQuery.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('pageshow', sync);
    };
  }, []);
  return dark;
}

const TOOL_LABEL = { claude: 'Claude Code', opencode: 'opencode', codex: 'Codex' } as const;

export function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [filter, setFilter] = useState<string | null>(() => load('filter', null));
  const [lanes, setLanes] = useState<boolean>(() => load('lanes', true));
  const [message, setMessage] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [search, setSearch] = useState('');
  const [toolFilter, setToolFilter] = useState<Card['tool'] | null>(() => load('toolFilter', null));
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => load('theme', 'system'));

  useEffect(() => {
    save('toolFilter', toolFilter);
  }, [toolFilter]);
  const systemDark = useSystemDark();
  const light = theme === 'light' || (theme === 'system' && !systemDark);
  useEffect(() => {
    save('theme', theme);
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    // The server pings every 10 s; with no message for 25 s the stream is dead (e.g. the server restarted
    // behind the Vite proxy, which keeps the page's connection open), so open a new one.
    let es: EventSource;
    let heard = Date.now();
    const connect = () => {
      es = new EventSource('/api/stream');
      es.onmessage = (e) => {
        heard = Date.now();
        setBoard(JSON.parse(e.data));
      };
      es.addEventListener('ping', () => (heard = Date.now()));
      es.onerror = () => setBoard((b) => (b ? { ...b, errors: ['lost connection to Session Slayer'] } : b));
    };
    connect();
    const watchdog = setInterval(() => {
      if (Date.now() - heard < 25_000) return;
      heard = Date.now();
      es.close();
      connect();
    }, 5_000);
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      es.close();
      clearInterval(watchdog);
      clearInterval(t);
    };
  }, []);

  // "/" focuses the search box, unless you are already typing somewhere
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => save('filter', filter), [filter]);
  useEffect(() => save('lanes', lanes), [lanes]);

  const act = async (fn: () => Promise<Record<string, string>>) => {
    try {
      const r = await fn();
      if (r.message) setMessage(r.message);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  if (!board) return <div className="loading">Loading sessions…</div>;

  const allTags = sortLanes(board.cards);
  const q = search.trim().toLowerCase();
  const cards = board.cards
    .filter((c) => !filter || c.lane === filter)
    .filter((c) => !toolFilter || c.tool === toolFilter)
    .filter((c) => !q || [c.name, c.branch, c.ticket].some((s) => s?.toLowerCase().includes(q)));
  const laneNames = lanes ? sortLanes(cards) : [''];

  return (
    <div className="app">
      <header>
        <img src="/logo.png" alt="" className="logo" />
        <h1>Session Slayer</h1>
        <button className="primary" disabled={!board.weztermAvailable} onClick={() => setShowNew(true)}>
          + New session
        </button>
        <div className="lane-filter">
          <button className={lanes ? 'toggle on' : 'toggle'} title="Group cards by lane" onClick={() => setLanes(!lanes)}>
            Lanes
          </button>
          <div className="group">
            <button className={!filter ? 'on' : ''} onClick={() => setFilter(null)}>
              all
            </button>
            {allTags.map((t) => (
              <button key={t} className={filter === t ? 'on' : ''} onClick={() => setFilter(t)}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="group">
          {([null, 'claude', 'opencode', 'codex'] as const).map((t) => (
            <button key={t ?? 'all'} className={toolFilter === t ? 'on' : ''} onClick={() => setToolFilter(t)}>
              {t ? TOOL_LABEL[t] : 'all tools'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <input
          ref={searchRef}
          className="search"
          type="search"
          placeholder="Search sessions… ( / )"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>

      <UsageBar usage={board.usage} />

      {board.errors.map((e) => (
        <div key={e} className="banner">
          {e}
        </div>
      ))}
      {message && (
        <div className="toast" onClick={() => setMessage(null)}>
          {message} <span className="dismiss">✕</span>
        </div>
      )}

      <div className={lanes ? 'grid with-lanes' : 'grid'}>
        {lanes && <div />}
        {COLUMNS.map((c) => (
          <div key={c.key} className={`col-title ${c.key}`}>
            {c.title} <span className="count">{cards.filter((x) => x.column === c.key).length}</span>
          </div>
        ))}
        {laneNames.map((lane) => (
          <Lane
            key={lane}
            lane={lane}
            showTitle={lanes}
            cards={lanes ? cards.filter((c) => c.lane === lane) : cards}
            now={now}
            act={act}
            weztermAvailable={board.weztermAvailable}
          />
        ))}
      </div>
      {!cards.length && <p className="empty">{q || filter ? 'No sessions match.' : 'No sessions. Start one with “+ New session”.'}</p>}

      <div className="horde-band">
        <img className="horde" src={hordeImage(board.cards.length, light)} alt={`${board.cards.length} sessions`} />
        <div className="group theme-switch" title="Theme">
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button key={t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {showNew && <NewSession onClose={() => setShowNew(false)} act={act} />}
    </div>
  );
}

const money = (usd: number) => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)}`;

function usageText(card: Card): string {
  return [card.costUsd !== undefined && money(card.costUsd), card.contextPct !== undefined && `${Math.round(card.contextPct)}% ctx`]
    .filter(Boolean)
    .join(' · ');
}

function Meter({ label, limit }: { label: string; limit: { pct: number; resetsAt: number } }) {
  const pct = Math.min(100, Math.max(0, limit.pct));
  const reset = new Date(limit.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <span className="meter" title={`resets ${reset}`}>
      {label}
      <span className="bar">
        <span className={pct >= 80 ? 'fill high' : 'fill'} style={{ width: `${pct}%` }} />
      </span>
      {Math.round(pct)}% <span className="muted">· resets {reset}</span>
    </span>
  );
}

function SpendMeter({ spend, title }: { spend: Spend; title?: string }) {
  return (
    <span className="meter" title={title}>
      today <strong>{money(spend.today)}</strong> <span className="muted">· week</span> <strong>{money(spend.week)}</strong>{' '}
      <span className="muted">· month</span> <strong>{money(spend.month)}</strong>
    </span>
  );
}

function UsageGroup({ tool, children }: { tool: string; children: ReactNode }) {
  return (
    <div className="usage-group">
      <span className="usage-tool">{tool}</span>
      {children}
    </div>
  );
}

function UsageBar({ usage }: { usage: Board['usage'] }) {
  const { claude5h, claude7d, claudeSpend, codex5h, codex7d, opencodeSpend } = usage;
  if (!Object.values(usage).some((v) => v !== undefined)) return null;
  return (
    <div className="usage-bar">
      {(claude5h || claude7d || claudeSpend) && (
        <UsageGroup tool="Claude">
          {claude5h && <Meter label="5h" limit={claude5h} />}
          {claude7d && <Meter label="week" limit={claude7d} />}
          {claudeSpend && <SpendMeter spend={claudeSpend} title="Estimated at list price" />}
        </UsageGroup>
      )}
      {(codex5h || codex7d) && (
        <UsageGroup tool="Codex">
          {codex5h && <Meter label="5h" limit={codex5h} />}
          {codex7d && <Meter label="week" limit={codex7d} />}
        </UsageGroup>
      )}
      {opencodeSpend && (
        <UsageGroup tool="opencode">
          <SpendMeter spend={opencodeSpend} />
        </UsageGroup>
      )}
    </div>
  );
}

type Act = (fn: () => Promise<Record<string, string>>) => Promise<void>;

function Lane(props: { lane: string; showTitle: boolean; cards: Card[]; now: number; act: Act; weztermAvailable: boolean }) {
  return (
    <>
      {props.showTitle && <div className="lane-title">{props.lane}</div>}
      {COLUMNS.map((c) => (
        <div key={c.key} className="cell">
          {props.cards
            .filter((card) => card.column === c.key)
            .sort((a, b) => a.columnSince - b.columnSince)
            .map((card) => (
              <SessionCard key={card.sessionId} card={card} showRepo={!props.showTitle || card.lane !== card.repo} now={props.now} act={props.act} canFocus={props.weztermAvailable} />
            ))}
        </div>
      ))}
    </>
  );
}

function SessionCard({ card, showRepo, now, act, canFocus }: { card: Card; showRepo: boolean; now: number; act: Act; canFocus: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(card.name);
  const [recap, setRecap] = useState<{ text: string; ts: number } | null | undefined>(undefined);
  const id = encodeURIComponent(card.sessionId);

  const showRecap = (e: MouseEvent) => {
    e.stopPropagation();
    fetch(`/api/sessions/${id}/recap`)
      .then((r) => r.json())
      .then(setRecap)
      .catch(() => setRecap(null));
  };

  const saveName = () => {
    setEditing(false);
    if (name !== card.name) act(() => api('PUT', `/api/sessions/${id}/name`, { name }));
  };

  return (
    <div
      className={`card ${card.column} ${canFocus ? 'clickable' : ''}`}
      title={card.cwd}
      onClick={() => canFocus && act(() => api('POST', `/api/sessions/${id}/focus`))}
    >
      <div className="card-top">
        {editing ? (
          <input
            autoFocus
            value={name}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === 'Enter' && saveName()}
          />
        ) : (
          <span
            className="name"
            title="Click to rename"
            onClick={(e) => {
              e.stopPropagation();
              setName(card.name);
              setEditing(true);
            }}
          >
            {card.name}
          </span>
        )}
        {card.tool === 'claude' && (
          <button className="info" title="Recap" aria-label="Recap" onClick={showRecap}>
            ⓘ
          </button>
        )}
        <span className="spacer" />
        {card.column !== 'working' && (
          <button
            className="close"
            title="Close this session"
            onClick={(e) => {
              e.stopPropagation();
              act(() => api('POST', `/api/sessions/${id}/close`));
            }}
          >
            Close
          </button>
        )}
      </div>
      <div className="card-bottom">
        <div className="meta">
          <div className="tags">
            {card.ticket && <span className="tag ticket">{card.ticket}</span>}
            {card.repo && showRepo && <span className="tag">{card.repo}</span>}
            {card.worktree ? (
              <span className="tag branch" title={`git worktree${card.branch ? ` on branch ${card.branch}` : ''}`}>
                🌳 {card.worktree}
              </span>
            ) : (
              card.branch && <span className="tag branch" title="git branch">⎇ {card.branch}</span>
            )}
          </div>
          <div className="tags">
            <span className={`tag ${card.tool}`}>{TOOL_LABEL[card.tool]}</span>
            {card.model && <span className="tag model" title="model">{card.model}</span>}
            {card.kind === 'background' && <span className="tag bg">background</span>}
            {!card.inWezterm && card.kind === 'interactive' && <span className="tag warn">not in WezTerm</span>}
          </div>
        </div>
        <span className="age">
          {usageText(card) && <span className="usage">{usageText(card)} · </span>}
          {age(card.columnSince, now)}
        </span>
      </div>
      {card.column === 'idle' && canFocus && !card.inWezterm && card.kind === 'interactive' && (
        <button
          className="move"
          title="Stops Claude in the other terminal and resumes this session in a new WezTerm tab"
          onClick={(e) => {
            e.stopPropagation();
            act(() => api('POST', `/api/sessions/${id}/move`));
          }}
        >
          Move to WezTerm
        </button>
      )}
      {recap !== undefined &&
        createPortal(
        <div
          className="overlay"
          onClick={(e) => {
            e.stopPropagation();
            setRecap(undefined);
          }}
        >
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{card.name}</h2>
            <p className="recap">{recap ? recap.text : 'No recap yet.'}</p>
            {recap && <span className="age">{age(recap.ts, now) === 'now' ? 'just now' : `${age(recap.ts, now)} ago`}</span>}
            <div className="actions">
              <button onClick={() => setRecap(undefined)}>Close</button>
            </div>
          </div>
        </div>,
          document.body,
        )}
    </div>
  );
}

function NewSession({ onClose, act }: { onClose: () => void; act: Act }) {
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [tool, setTool] = useState<Card['tool']>(() => load('newTool', 'claude'));

  useEffect(() => {
    fetch('/api/repos')
      .then((r) => r.json())
      .then((list: string[]) => {
        setRepos(list);
        setRepo(list[0] ?? '');
      });
  }, []);

  const start = async () => {
    save('newTool', tool);
    await act(() => api('POST', '/api/sessions', { repo, name, tool }));
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>New session</h2>
        <label>
          Repo
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <div className="tool-switch">
          {(['claude', 'opencode', 'codex'] as const).map((t) => (
            <button key={t} className={tool === t ? 'chip on' : 'chip'} onClick={() => setTool(t)}>
              {TOOL_LABEL[t]}
            </button>
          ))}
        </div>
        <label>
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ABC-123 fix login" />
        </label>
        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!repo} onClick={start}>
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
