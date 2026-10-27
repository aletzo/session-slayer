import path from 'node:path';

const TICKET = /FIRE-\d+/;

export type Tags = { repo?: string; ticket?: string; lane: string; tags: string[] };

export function tagsFor(
  cwd: string,
  firstPrompt: string | undefined,
  name: string | undefined,
  home: string,
): Tags {
  const rel = path.relative(path.join(home, 'dev'), cwd);
  const repo = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : undefined;

  const ticket = [cwd, firstPrompt, name].map((s) => s?.match(TICKET)?.[0]).find(Boolean);

  const tags = [ticket && 'fireline', repo].filter((t): t is string => !!t);
  return { repo, ticket, lane: ticket ? 'fireline' : (repo ?? 'other'), tags };
}
