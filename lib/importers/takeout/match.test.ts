import { describe, expect, test } from 'vitest';
import { findSidecarByName, findSidecarByTitle, livePhotoKey, sidecarCandidates, titleKeys, type SidecarInfo } from './match';

const folder = (...items: [string, string | null][]) => new Map<string, SidecarInfo>(items.map(([name, title]) => [name, { name, title }]));
const names = (file: string) => sidecarCandidates(file).map((c) => c.name);

describe('sidecarCandidates', () => {
  test('both naming styles come first, cut variants after', () => {
    const list = names('IMG_1.jpg');
    expect(list.slice(0, 2)).toEqual(['IMG_1.jpg.json', 'IMG_1.jpg.supplemental-metadata.json']);
    expect(list).toContain('IMG_1.jpg.supplemental-meta.json');
    expect(list).toContain('IMG_1.jpg.s.json');
  });
  test('a (1) duplicate and an edited copy map to their sidecar names', () => {
    expect(names('IMG_1(1).jpg')).toContain('IMG_1.jpg(1).json');
    expect(names('IMG_1-edited.jpg')).toContain('IMG_1.jpg.json');
  });
  test('a long name is cut at 46 characters', () => {
    const long = `${'a'.repeat(60)}.jpg`;
    const cut = `${(long + '.supplemental-metadata').slice(0, 46)}.json`;
    expect(names(long)).toContain(cut);
  });
});

describe('findSidecarByName', () => {
  test('exact names match without needing a title', () => {
    expect(findSidecarByName('a.jpg', folder(['a.jpg.json', null]))?.name).toBe('a.jpg.json');
  });
  test('a cut name must agree with the title', () => {
    const cut = `${'a'.repeat(40)}.jpg.supplemental-metadata`.slice(0, 46);
    const file = `${'a'.repeat(40)}.jpg`;
    expect(findSidecarByName(file, folder([`${cut}.json`, file]))).not.toBeNull();
    expect(findSidecarByName(file, folder([`${cut}.json`, 'another.jpg']))).toBeNull();
  });
  test('a cut name with a sidecar that has no title is not accepted', () => {
    const cut = `${'a'.repeat(40)}.jpg.supplemental-metadata`.slice(0, 46);
    expect(findSidecarByName(`${'a'.repeat(40)}.jpg`, folder([`${cut}.json`, null]))).toBeNull();
  });
  test('nothing matches nothing', () => {
    expect(findSidecarByName('a.jpg', folder(['b.jpg.json', 'b.jpg']))).toBeNull();
  });
});

describe('findSidecarByTitle', () => {
  test('takes the one sidecar whose title is exactly the name, never an ambiguous one', () => {
    expect(findSidecarByTitle('a.jpg', folder(['x.json', 'a.jpg']), new Set())?.name).toBe('x.json');
    expect(findSidecarByTitle('a.jpg', folder(['x.json', 'a.jpg'], ['y.json', 'a.jpg']), new Set())).toBeNull();
  });
  test('a (1) duplicate without a sidecar does not take the original title', () => {
    expect(findSidecarByTitle('IMG_1(1).jpg', folder(['IMG_1.jpg.json', 'IMG_1.jpg']), new Set())).toBeNull();
  });
  test('a sidecar another picture claimed by name is not taken', () => {
    expect(findSidecarByTitle('a.jpg', folder(['x.json', 'a.jpg']), new Set(['x.json']))).toBeNull();
  });
  test('a null title matches nothing', () => {
    expect(findSidecarByTitle('a.jpg', folder(['x.json', null]), new Set())).toBeNull();
  });
});

describe('helpers', () => {
  test('titleKeys drops (n) and -edited', () => {
    expect(titleKeys('IMG_1-edited.jpg').has('IMG_1.jpg')).toBe(true);
    expect(titleKeys('IMG_1(1).jpg').has('IMG_1.jpg')).toBe(true);
  });
  test('livePhotoKey ignores the extension but not the name', () => {
    expect(livePhotoKey('IMG_1.MP4')).toBe(livePhotoKey('IMG_1.jpg'));
    expect(livePhotoKey('IMG_1.MP4')).not.toBe(livePhotoKey('img_1.jpg'));
  });
});
