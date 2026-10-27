import { useEffect, useState } from 'react';
import { sortLanes } from '../src/lanes';
import type { Board, Card, Column } from '../src/types';

const COLUMNS: { key: Column; title: string }[] = [
  { key: 'working', title: 'Working' },
  { key: 'needs_input', title: 'Needs input' },
  { key: 'done', title: 'Done' },
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

export function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [filter, setFilter] = useState<string | null>(() => load('filter', null));
  const [lanes, setLanes] = useState<boolean>(() => load('lanes', true));
  const [message, setMessage] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => setBoard(JSON.parse(e.data));
    es.onerror = () => setBoard((b) => (b ? { ...b, errors: ['lost connection to Session Slayer'] } : b));
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      es.close();
      clearInterval(t);
    };
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

  const allTags = sortLanes([...new Set(board.cards.flatMap((c) => c.tags))]);
  const cards = filter ? board.cards.filter((c) => c.tags.includes(filter)) : board.cards;
  const laneNames = lanes ? sortLanes([...new Set(cards.map((c) => c.lane))]) : [''];

  return (
    <div className="app">
      <header>
        <img src="/logo.svg" alt="" className="logo" />
        <h1>Session Slayer</h1>
        <button className="primary" disabled={!board.weztermAvailable} onClick={() => setShowNew(true)}>
          + New session
        </button>
        <div className="chips">
          <button className={!filter ? 'chip on' : 'chip'} onClick={() => setFilter(null)}>
            all
          </button>
          {allTags.map((t) => (
            <button key={t} className={filter === t ? 'chip on' : 'chip'} onClick={() => setFilter(t)}>
              {t}
            </button>
          ))}
        </div>
        <button className="chip" onClick={() => setLanes(!lanes)}>
          Lanes: {lanes ? 'on' : 'off'}
        </button>
      </header>

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
      {!cards.length && <p className="empty">No sessions. Start one with “+ New session”.</p>}

      {showNew && <NewSession onClose={() => setShowNew(false)} act={act} />}
    </div>
  );
}

type Act = (fn: () => Promise<Record<string, string>>) => Promise<void>;

function Lane(props: { lane: string; showTitle: boolean; cards: Card[]; now: number; act: Act; weztermAvailable: boolean }) {
  return (
    <>
      {props.showTitle && <div className={`lane-title ${props.lane === 'fireline' ? 'fireline' : ''}`}>{props.lane}</div>}
      {COLUMNS.map((c) => (
        <div key={c.key} className="cell">
          {props.cards
            .filter((card) => card.column === c.key)
            .sort((a, b) => a.columnSince - b.columnSince)
            .map((card) => (
              <SessionCard key={card.sessionId} card={card} now={props.now} act={props.act} canFocus={props.weztermAvailable} />
            ))}
        </div>
      ))}
    </>
  );
}

function SessionCard({ card, now, act, canFocus }: { card: Card; now: number; act: Act; canFocus: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(card.name);
  const id = encodeURIComponent(card.sessionId);

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
        <span className="age">{age(card.columnSince, now)}</span>
      </div>
      <div className="meta">
        {card.ticket && <span className="tag ticket">{card.ticket}</span>}
        {card.repo && <span className="tag">{card.repo}</span>}
        {card.kind === 'background' && <span className="tag bg">background</span>}
        {!card.inWezterm && card.kind === 'interactive' && <span className="tag warn">not in WezTerm</span>}
      </div>
      {card.firstPrompt && <div className="prompt">{card.firstPrompt}</div>}
      {card.column === 'done' && canFocus && !card.inWezterm && card.kind === 'interactive' && (
        <button
          className="close move"
          title="Stops Claude in the other terminal and resumes this session in a new WezTerm tab"
          onClick={(e) => {
            e.stopPropagation();
            act(() => api('POST', `/api/sessions/${id}/move`));
          }}
        >
          Move to WezTerm
        </button>
      )}
      {card.column === 'done' && (
        <button
          className="close"
          onClick={(e) => {
            e.stopPropagation();
            act(() => api('POST', `/api/sessions/${id}/close`));
          }}
        >
          Close
        </button>
      )}
    </div>
  );
}

function NewSession({ onClose, act }: { onClose: () => void; act: Act }) {
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');

  useEffect(() => {
    fetch('/api/repos')
      .then((r) => r.json())
      .then((list: string[]) => {
        setRepos(list);
        setRepo(list[0] ?? '');
      });
  }, []);

  const start = async () => {
    await act(() => api('POST', '/api/sessions', { repo, name }));
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
        <label>
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. FIRE-12345 missing docs" />
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
