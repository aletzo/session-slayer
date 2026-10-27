import { describe, expect, it } from 'vitest';
import { tagsFor } from '../src/tags';

const H = '/Users/me';

describe('tagsFor', () => {
  it('repo from ~/dev/<repo>, also in subfolders', () => {
    expect(tagsFor(`${H}/dev/GIS-shared/packages/x`, undefined, undefined, H)).toMatchObject({ repo: 'GIS-shared', lane: 'GIS-shared', tags: ['GIS-shared'] });
  });
  it('other lane outside ~/dev', () => {
    expect(tagsFor(`${H}/code/llm-wiki`, undefined, undefined, H)).toMatchObject({ repo: undefined, lane: 'other', tags: [] });
    expect(tagsFor(`${H}/devtools`, undefined, undefined, H).repo).toBeUndefined();
  });
  it('ticket order: cwd, then first prompt, then name', () => {
    expect(tagsFor(`${H}/dev/r/FIRE-1`, 'FIRE-2', 'FIRE-3', H).ticket).toBe('FIRE-1');
    expect(tagsFor(`${H}/dev/r`, 'look at FIRE-2', 'FIRE-3', H).ticket).toBe('FIRE-2');
    expect(tagsFor(`${H}/dev/r`, 'hi', 'FIRE-3 docs', H)).toMatchObject({ ticket: 'FIRE-3', lane: 'fireline', tags: ['fireline', 'r'] });
  });
  it('no ticket', () => {
    expect(tagsFor(`${H}/dev/r`, 'FIRE- nope', 'fire-12', H).ticket).toBeUndefined();
  });
});
