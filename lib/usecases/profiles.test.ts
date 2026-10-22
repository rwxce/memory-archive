import { describe, expect, test } from 'vitest';
import { PROFILE_DESCRIPTION_MAX, PROFILE_NAME_MAX, PROFILE_RELATIONSHIP_MAX } from '../domain/profile';
import {
  archiveProfile,
  createProfile,
  getProfileDetails,
  listProfiles,
  unarchiveProfile,
  updateProfile,
} from './profiles';
import { createTestLibrary } from './test-client';

type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
/** Stores synthetic bytes in the blob store and returns the reference a profile photo uses. */
async function stored(lib: Lib, text: string, mime: string | null = 'image/jpeg') {
  const { sha256, size } = await lib.deps.blobStore.put(new TextEncoder().encode(text));
  return { sha256, size, mime };
}

const ids = {
  profile: '00000000-0000-4000-8000-000000000001',
  missing: '99999999-9999-4999-8999-999999999999',
};

describe('create profile', () => {
  test('stores trimmed details, with a generated id and the injected clock', async () => {
    const lib = await createTestLibrary();
    const { deps, opened } = lib;
    const PHOTO = await stored(lib, 'photo one');
    const profile = await createProfile(deps, {
      displayName: '  Ana  ',
      relationship: ' friend ',
      description: ' Met at school.\nSynthetic. ',
      photo: PHOTO,
    });
    expect(profile).toEqual({
      id: ids.profile,
      displayName: 'Ana',
      relationship: 'friend',
      description: 'Met at school.\nSynthetic.',
      photoSha256: PHOTO.sha256,
      archivedAt: null,
      createdAt: '2026-03-01T10:00:00.000Z',
      updatedAt: '2026-03-01T10:00:00.000Z',
    });
    expect(opened.db.all('SELECT sha256, size, mime FROM blobs')).toEqual([PHOTO]);
  });

  test('only a name is required; the rest defaults to empty and no photo', async () => {
    const { deps } = await createTestLibrary();
    expect(await createProfile(deps, { displayName: 'Bo' })).toMatchObject({ relationship: '', description: '', photoSha256: null });
  });

  test('uses crypto.randomUUID when no id source is injected', async () => {
    const { client } = await createTestLibrary();
    const { deps } = await createTestLibrary();
    const profile = await createProfile({ ...deps, client, newId: undefined }, { displayName: 'Cy' });
    expect(profile.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('rejects invalid input with code invalid and stores nothing', async () => {
    const lib = await createTestLibrary();
    const { deps, opened } = lib;
    const PHOTO = await stored(lib, 'photo one');
    const bad = [
      { displayName: '' },
      { displayName: '   ' },
      { displayName: 'x'.repeat(PROFILE_NAME_MAX + 1) },
      { displayName: 'Line\nbreak' },
      { displayName: 'Nul\u0000' },
      { displayName: 'Ana', relationship: 'x'.repeat(PROFILE_RELATIONSHIP_MAX + 1) },
      { displayName: 'Ana', relationship: 'a\nb' },
      { displayName: 'Ana', description: 'x'.repeat(PROFILE_DESCRIPTION_MAX + 1) },
      { displayName: 'Ana', photo: { ...PHOTO, sha256: 'XY'.repeat(32) } },
      { displayName: 'Ana', photo: { ...PHOTO, sha256: 'ab' } },
      { displayName: 'Ana', photo: { ...PHOTO, size: -1 } },
      { displayName: 'Ana', photo: { ...PHOTO, size: PHOTO.size + 1 } },
      { displayName: 'Ana', photo: { ...PHOTO, mime: 'image jpeg' } },
      { displayName: 'Ana', photo: { ...PHOTO, mime: 'image/jpeg; charset=x' } },
      { displayName: 'Ana', photo: { ...PHOTO, mime: `image/${'a'.repeat(300)}` } },
      { displayName: 'Ana', photo: { ...PHOTO, mime: '' } },
      { displayName: 7 as unknown as string },
    ];
    for (const input of bad) await expect(createProfile(deps, input), JSON.stringify(input)).rejects.toMatchObject({ code: 'invalid' });
    expect(opened.db.all('SELECT id FROM profiles')).toEqual([]);
    expect(opened.db.all('SELECT sha256 FROM blobs')).toEqual([]);
  });

  test('a name at exactly the limit is accepted; the description keeps its line breaks', async () => {
    const { deps } = await createTestLibrary();
    const profile = await createProfile(deps, { displayName: 'x'.repeat(PROFILE_NAME_MAX), description: 'a\r\nb' });
    expect(profile.displayName).toHaveLength(PROFILE_NAME_MAX);
    expect(profile.description).toBe('a\r\nb');
  });

  test('the same photo on two profiles is one blob row', async () => {
    const lib = await createTestLibrary();
    const { deps, opened } = lib;
    const PHOTO = await stored(lib, 'photo one');
    await createProfile(deps, { displayName: 'Ana', photo: PHOTO });
    await createProfile(deps, { displayName: 'Bo', photo: PHOTO });
    expect(opened.db.all('SELECT sha256 FROM blobs')).toHaveLength(1);
  });
});

describe('update profile', () => {
  test('changes only the given fields and bumps updatedAt', async () => {
    const lib = await createTestLibrary();
    const { deps } = lib;
    const PHOTO = await stored(lib, 'photo one');
    await createProfile(deps, { displayName: 'Ana', relationship: 'friend', description: 'note', photo: PHOTO });
    const later = { ...deps, now: () => new Date('2026-04-01T00:00:00Z') };
    const updated = await updateProfile(later, ids.profile, { displayName: ' Anna ' });
    expect(updated).toMatchObject({ displayName: 'Anna', relationship: 'friend', description: 'note', photoSha256: PHOTO.sha256 });
    expect(updated.createdAt).toBe('2026-03-01T10:00:00.000Z');
    expect(updated.updatedAt).toBe('2026-04-01T00:00:00.000Z');
  });

  test('empty strings clear relationship and description; null removes the photo, a new one replaces it', async () => {
    const lib = await createTestLibrary();
    const { deps } = lib;
    const PHOTO = await stored(lib, 'photo one');
    await createProfile(deps, { displayName: 'Ana', relationship: 'friend', description: 'note', photo: PHOTO });
    expect(await updateProfile(deps, ids.profile, { relationship: '', description: '  ', photo: null })).toMatchObject({
      relationship: '',
      description: '',
      photoSha256: null,
    });
    const other = await stored(lib, 'photo two', null);
    expect((await updateProfile(deps, ids.profile, { photo: other })).photoSha256).toBe(other.sha256);
  });

  test('an invalid field changes nothing; a missing profile is not-found', async () => {
    const { deps } = await createTestLibrary();
    await createProfile(deps, { displayName: 'Ana' });
    await expect(updateProfile(deps, ids.profile, { displayName: 'Ok', description: 'x'.repeat(PROFILE_DESCRIPTION_MAX + 1) })).rejects.toMatchObject({ code: 'invalid' });
    await expect(updateProfile(deps, ids.profile, { displayName: ' ' })).rejects.toMatchObject({ code: 'invalid' });
    expect((await getProfileDetails(deps, ids.profile)).profile.displayName).toBe('Ana');
    await expect(updateProfile(deps, ids.missing, { displayName: 'X' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(updateProfile(deps, 'nope', { displayName: 'X' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('archive and list', () => {
  test('archive hides from the active list, unarchive restores it; both are idempotent', async () => {
    const { deps } = await createTestLibrary();
    await createProfile(deps, { displayName: 'Ana' });
    await createProfile(deps, { displayName: 'Bo' });
    const archived = await archiveProfile(deps, ids.profile);
    expect(archived.archivedAt).toBe('2026-03-01T10:00:00.000Z');
    const again = await archiveProfile({ ...deps, now: () => new Date('2027-01-01T00:00:00Z') }, ids.profile);
    expect(again).toEqual(archived);

    expect((await listProfiles(deps)).map((p) => p.displayName)).toEqual(['Bo']);
    expect((await listProfiles(deps, 'archived')).map((p) => p.displayName)).toEqual(['Ana']);
    expect((await listProfiles(deps, 'all')).map((p) => p.displayName)).toEqual(['Ana', 'Bo']);

    expect((await unarchiveProfile(deps, ids.profile)).archivedAt).toBeNull();
    expect((await unarchiveProfile(deps, ids.profile)).archivedAt).toBeNull();
    expect((await listProfiles(deps)).map((p) => p.displayName)).toEqual(['Ana', 'Bo']);
    await expect(archiveProfile(deps, ids.missing)).rejects.toMatchObject({ code: 'not-found' });
  });

  test('archiving keeps the conversations and messages of the profile', async () => {
    const { deps, opened } = await createTestLibrary();
    await createProfile(deps, { displayName: 'Ana' });
    opened.db.run("INSERT INTO conversations (id, title, source, created_at) VALUES ('00000000-0000-4000-8000-0000000000c1', 'Chat', 'whatsapp', 't')");
    opened.db.run("INSERT INTO conversation_profiles VALUES ('00000000-0000-4000-8000-0000000000c1', ?)", [ids.profile]);
    await archiveProfile(deps, ids.profile);
    const details = await getProfileDetails(deps, ids.profile);
    expect(details.profile.archivedAt).not.toBeNull();
    expect(details.conversations.map((c) => c.title)).toEqual(['Chat']);
  });

  test('an unknown list state is invalid', async () => {
    const { client } = await createTestLibrary();
    await expect(client.call('listProfiles', { state: 'deleted' as 'all' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('profile details', () => {
  test('returns the profile with only its own conversations', async () => {
    const { deps, opened } = await createTestLibrary();
    await createProfile(deps, { displayName: 'Ana' });
    await createProfile(deps, { displayName: 'Bo' });
    const [ana, bo] = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    for (const [id, title, who] of [['c1', 'With Ana', [ana]], ['c2', 'With Bo', [bo]], ['c3', 'Group', [ana, bo]]] as const) {
      const cid = `00000000-0000-4000-8000-0000000000${id}`;
      opened.db.run("INSERT INTO conversations (id, title, source, is_group, created_at) VALUES (?, ?, 'whatsapp', ?, 't')", [cid, title, id === 'c3' ? 1 : 0]);
      for (const p of who) opened.db.run('INSERT INTO conversation_profiles VALUES (?, ?)', [cid, p]);
    }
    const details = await getProfileDetails(deps, ana);
    expect(details.profile.displayName).toBe('Ana');
    expect(details.conversations.map((c) => c.title)).toEqual(['With Ana', 'Group']);
    await expect(getProfileDetails(deps, ids.missing)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('photo integrity', () => {
  const blobRows = (lib: Lib) => lib.opened.db.all('SELECT sha256 FROM blobs');

  test('a hash that is not in the blob store is not-found and leaves no blob row', async () => {
    const lib = await createTestLibrary();
    const ghost = { sha256: 'ab'.repeat(32), size: 5, mime: 'image/png' };
    await expect(createProfile(lib.deps, { displayName: 'Ana', photo: ghost })).rejects.toMatchObject({ code: 'not-found' });
    expect(blobRows(lib)).toEqual([]);
    await createProfile(lib.deps, { displayName: 'Ana' });
    await expect(updateProfile(lib.deps, ids.profile, { photo: ghost })).rejects.toMatchObject({ code: 'not-found' });
    expect(blobRows(lib)).toEqual([]);
  });

  test('a wrong size or a bad media type is invalid and leaves no blob row (create and update)', async () => {
    const lib = await createTestLibrary();
    const real = await stored(lib, 'real bytes');
    await createProfile(lib.deps, { displayName: 'Ana' });
    for (const photo of [{ ...real, size: real.size + 1 }, { ...real, size: 0 }, { ...real, mime: 'not a mime' }, { ...real, mime: 'x'.repeat(256) }]) {
      await expect(createProfile(lib.deps, { displayName: 'Bo', photo })).rejects.toMatchObject({ code: 'invalid' });
      await expect(updateProfile(lib.deps, ids.profile, { photo })).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(blobRows(lib)).toEqual([]);
    expect((await listProfiles(lib.deps, 'all')).map((p) => p.photoSha256)).toEqual([null]);
  });

  test('a duplicate profile id with a photo rolls the photo row back with the failed insert', async () => {
    const lib = await createTestLibrary();
    const photo = await stored(lib, 'avatar');
    const fixed = { ...lib.deps, newId: () => ids.profile };
    await createProfile(fixed, { displayName: 'Ana' });
    await expect(createProfile(fixed, { displayName: 'Dup', photo })).rejects.toMatchObject({ code: 'constraint' });
    expect(blobRows(lib)).toEqual([]);
    expect((await listProfiles(lib.deps, 'all')).map((p) => p.displayName)).toEqual(['Ana']);
  });
});

describe('names', () => {
  const rejected = ['\u200b', '\u200b\u200b', '\u200e', '\u200f', '\u2800', '\u3164', '\u202e', '\u202a\u202c', '\u2066\u2069 \u200b', 'a\u0085b', '\u0085', 'a\u0080', '\ud800', 'Ana\udc00', '\u00a0\u200b \u2800'];

  test('invisible, bidi-override, C1 and malformed-Unicode names are invalid and store nothing', async () => {
    const lib = await createTestLibrary();
    for (const displayName of rejected) {
      await expect(createProfile(lib.deps, { displayName }), JSON.stringify(displayName)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(createProfile(lib.deps, { displayName: 'Ana', relationship: 'a\u2028b' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createProfile(lib.deps, { displayName: 'Ana', description: 'a\u0085b' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createProfile(lib.deps, { displayName: 'Ana', description: 'x\udc00' })).rejects.toMatchObject({ code: 'invalid' });
    expect(lib.opened.db.all('SELECT id FROM profiles')).toEqual([]);
  });

  test('bidi controls are stripped from single-line fields, keeping the visible text in logical order', async () => {
    const lib = await createTestLibrary();
    expect((await createProfile(lib.deps, { displayName: 'Ana\u202eBo' })).displayName).toBe('AnaBo');
    expect((await createProfile(lib.deps, { displayName: '\u202a+34 600 00 00 00\u202c' })).displayName).toBe('+34 600 00 00 00');
    expect((await createProfile(lib.deps, { displayName: 'Ana', relationship: '\u2067mare\u2069' })).relationship).toBe('mare');
    const stored = lib.opened.db.all<{ display_name: string }>('SELECT display_name FROM profiles ORDER BY created_at, id');
    expect(stored.map((r) => r.display_name)).toEqual(['AnaBo', '+34 600 00 00 00', 'Ana']);
    expect(stored.every((r) => !/[\u202a-\u202e\u2066-\u2069]/.test(r.display_name))).toBe(true);
  });

  test('a bidi-only optional field is stripped to empty (not set)', async () => {
    const lib = await createTestLibrary();
    expect((await createProfile(lib.deps, { displayName: 'Ana', relationship: '\u202e\u202c' })).relationship).toBe('');
  });

  test('a visible name with invisible marks around it is accepted; Catalan, Spanish, CJK and emoji names are too', async () => {
    const lib = await createTestLibrary();
    for (const displayName of ['Núria Ça', 'José Ángel Peña', 'Zoë 山田', 'Ana \ud83d\ude00', '\u200eAna\u200f', 'Ana\u200dBo', 'ऐ']) {
      expect((await createProfile(lib.deps, { displayName })).displayName.length).toBeGreaterThan(0);
    }
  });

  test('descriptions may keep tab and line breaks but no other control characters', async () => {
    const lib = await createTestLibrary();
    expect((await createProfile(lib.deps, { displayName: 'Ana', description: 'a\tb\nc\r\nd' })).description).toBe('a\tb\nc\r\nd');
    await expect(createProfile(lib.deps, { displayName: 'Bo', description: 'a\u0000b' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
