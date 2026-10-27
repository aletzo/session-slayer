import path from 'node:path';

// A ticket key like ABC-123: the project key (ABC) becomes the lane.
const TICKET = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;
// Words that look like ticket keys but are not.
const NOT_PROJECTS = new Set(['UTF', 'ISO', 'SHA', 'RFC', 'HTTP', 'TLS', 'SSL', 'AES', 'RSA', 'CVE', 'CWE', 'IPV', 'MP', 'COVID']);

export type LaneKind = 'ticket' | 'repo' | 'other';
export type Tags = { repo?: string; ticket?: string; project?: string; lane: string; laneKind: LaneKind; tags: string[] };

export function findTicket(text: string | undefined): string | undefined {
  for (const m of text?.matchAll(TICKET) ?? []) if (!NOT_PROJECTS.has(m[1])) return m[0];
  return undefined;
}

export function tagsFor(cwd: string, firstPrompt: string | undefined, name: string | undefined, home: string): Tags {
  const rel = path.relative(path.join(home, 'dev'), cwd);
  const repo = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : undefined;

  // first match wins: folder, then first prompt, then name
  const ticket = [cwd, firstPrompt, name].map(findTicket).find(Boolean);
  const project = ticket?.split('-')[0];

  const tags = [project, repo].filter((t): t is string => !!t);
  if (project) return { repo, ticket, project, lane: project, laneKind: 'ticket', tags };
  return { repo, lane: repo ?? 'other', laneKind: repo ? 'repo' : 'other', tags };
}
