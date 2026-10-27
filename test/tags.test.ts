import { describe, expect, it } from 'vitest';
import { findTicket, tagsFor } from '../src/tags';

const H = '/Users/me';

describe('tagsFor', () => {
  it('no ticket: repo lane from ~/dev/<repo>, also in subfolders', () => {
    expect(tagsFor(`${H}/dev/web-app/packages/x`, undefined, undefined, H)).toMatchObject({ repo: 'web-app', lane: 'web-app', laneKind: 'repo', tags: ['web-app'] });
  });
  it('no ticket, outside ~/dev: other lane', () => {
    expect(tagsFor(`${H}/code/notes`, undefined, undefined, H)).toMatchObject({ repo: undefined, lane: 'other', laneKind: 'other', tags: [] });
    expect(tagsFor(`${H}/devtools`, undefined, undefined, H).repo).toBeUndefined();
  });
  it('ticket order: folder, then first prompt, then name', () => {
    expect(tagsFor(`${H}/dev/r/ABC-1`, 'DEF-2', 'GHI-3', H).ticket).toBe('ABC-1');
    expect(tagsFor(`${H}/dev/r`, 'look at DEF-2', 'GHI-3', H).ticket).toBe('DEF-2');
    expect(tagsFor(`${H}/dev/r`, 'hi', 'GHI-3 docs', H)).toMatchObject({ ticket: 'GHI-3', project: 'GHI', lane: 'GHI', laneKind: 'ticket', tags: ['GHI', 'r'] });
  });
});

describe('findTicket', () => {
  it.each([
    ['fix OPS-42 now', 'OPS-42'],
    ['A2B-7', 'A2B-7'],
    ['utf: UTF-8 then WEB-9', 'WEB-9'],
    ['ISO-8601 SHA-256 RFC-1234', undefined],
    ['abc-12 A-1 ABC- nope', undefined],
  ])('%s -> %s', (text, ticket) => {
    expect(findTicket(text)).toBe(ticket);
  });
});
