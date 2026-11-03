import { describe, expect, test } from 'vitest';
import { parseViewerData, serializeViewerData } from '../exporters/viewer/format';
import type { NewMessage } from '../domain/library';
import { buildViewerExport } from './viewer-export';
import { createTestLibrary } from './test-client';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-02-01T12:00:00Z';
const [ANA, BEN, C_ANA, C_BEN, C_BOTH] = [uuid(1), uuid(2), uuid(10), uuid(11), uuid(12)];

const msg = (n: number, day: number, over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: n.toString(16).padStart(64, '0'),
  sentAt: `2026-01-${String(day).padStart(2, '0')}T10:00:00`,
  ordinal: 0,
  type: 'text',
  participantName: '<b>Ana</b>',
  body: `synthetic ${n}`,
  mediaSha256: null,
  mediaName: '',
  ...over,
});

async function setup() {
  const lib = await createTestLibrary();
  const bytes = new Uint8Array([1, 2, 3]);
  const stored = await lib.deps.blobStore.put(bytes);
  const gone = 'cd'.repeat(32); // referenced but never stored
  await lib.client.call('createProfile', { id: ANA, displayName: 'Ana', now: NOW });
  await lib.client.call('createProfile', { id: BEN, displayName: 'Ben', now: NOW });
  const imp = (batch: number, conversationId: string, title: string, key: string, profileIds: string[], messages: NewMessage[]) =>
    lib.client.call('importMessages', {
      batchId: uuid(batch),
      conversationId,
      source: 'whatsapp',
      sourceLabel: 'x.zip',
      now: NOW,
      blobs: [
        { sha256: stored.sha256, size: 3, mime: 'image/jpeg' },
        { sha256: gone, size: 9, mime: 'image/png' },
      ],
      messages,
      newConversation: { title, sourceKey: key, isGroup: false, profileIds },
      meAuthor: '<b>Ana</b>',
    });
  await imp(100, C_ANA, 'Chat with Ana', 'ana', [ANA], [
    msg(1, 1),
    msg(2, 5, { type: 'photo', mediaSha256: stored.sha256, mediaName: 'IMG-1.JPG' }),
    msg(3, 9, { type: 'photo', mediaSha256: gone, mediaName: 'IMG-2.png' }),
    msg(4, 20),
  ]);
  await imp(101, C_BEN, 'Chat with Ben', 'ben', [BEN], [msg(5, 3, { participantName: 'Ben' })]);
  await imp(102, C_BOTH, 'Both', 'both', [ANA, BEN], [msg(6, 4, { participantName: 'Ben' })]);
  return { ...lib, hash: stored.sha256, gone };
}

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('buildViewerExport', () => {
  test('one profile: its conversations only, messages chronological, round trip through the island text', async () => {
    const { deps, hash } = await setup();
    const out = await buildViewerExport(deps, { profileIds: [ANA], includeMedia: true });
    expect(out.data.profiles.map((p) => p.displayName)).toEqual(['Ana']);
    expect(out.data.conversations.map((c) => c.title).sort()).toEqual(['Both', 'Chat with Ana']);
    const ana = out.data.conversations.find((c) => c.id === C_ANA)!;
    expect(ana.profileIds).toEqual([ANA]);
    expect(ana.messages.map((m) => m.text)).toEqual(['synthetic 1', 'synthetic 2', 'synthetic 3', 'synthetic 4']);
    expect(ana.messages[0]).toMatchObject({ author: '<b>Ana</b>', isMe: true, sentAt: '2026-01-01T10:00:00' });
    expect(ana.participants).toEqual([{ name: '<b>Ana</b>', isMe: true }]);
    expect(out.data.conversations.find((c) => c.id === C_BOTH)!.profileIds).toEqual([ANA]);
    expect(parseViewerData(serializeViewerData(out.data))).toEqual(out.data);
    expect(out.media).toEqual([{ sha256: hash, path: `media/${hash}.jpg`, size: 3, mime: 'image/jpeg' }]);
  });

  test('several profiles: a shared conversation appears once with both ids', async () => {
    const { deps } = await setup();
    const out = await buildViewerExport(deps, { profileIds: [BEN, ANA, ANA], includeMedia: false });
    expect(out.data.profiles.map((p) => p.displayName)).toEqual(['Ana', 'Ben']);
    expect(out.data.conversations).toHaveLength(3);
    expect(out.data.conversations.find((c) => c.id === C_BOTH)!.profileIds).toEqual([ANA, BEN]);
  });

  test('date range is inclusive and drops conversations with nothing in it', async () => {
    const { deps } = await setup();
    const out = await buildViewerExport(deps, { profileIds: [ANA, BEN], from: '2026-01-05', to: '2026-01-09', includeMedia: false });
    expect(out.data.selection).toMatchObject({ from: '2026-01-05', to: '2026-01-09' });
    expect(out.data.conversations.map((c) => [c.id, c.messages.length])).toEqual([[C_ANA, 2]]);
    const none = await buildViewerExport(deps, { profileIds: [ANA], from: '2026-03-01', includeMedia: false });
    expect(none.data.conversations).toEqual([]);
    const open = await buildViewerExport(deps, { profileIds: [ANA], to: '2026-01-04', includeMedia: false });
    expect(open.data.conversations.flatMap((c) => c.messages.map((m) => m.text))).toEqual(['synthetic 1', 'synthetic 6']);
  });

  test('media off keeps file names but no paths and no files; missing media is left out and counted', async () => {
    const { deps, gone } = await setup();
    const off = await buildViewerExport(deps, { profileIds: [ANA], includeMedia: false });
    expect(off.media).toEqual([]);
    expect(off.missingMedia).toBe(0);
    const photo = off.data.conversations.find((c) => c.id === C_ANA)!.messages[1];
    expect(photo).toMatchObject({ type: 'photo', media: null, mediaName: 'IMG-1.JPG' });

    const on = await buildViewerExport(deps, { profileIds: [ANA], includeMedia: true });
    const messages = on.data.conversations.find((c) => c.id === C_ANA)!.messages;
    expect(messages[1].media).toMatch(/^media\/[0-9a-f]{64}\.jpg$/);
    expect(messages[2]).toMatchObject({ media: null, mediaName: 'IMG-2.png' });
    expect(on.missingMedia).toBe(1);
    expect(JSON.stringify(on.data)).not.toContain(gone);
  });

  test('output is deterministic and independent of the order of the selection', async () => {
    const { deps } = await setup();
    const a = await buildViewerExport(deps, { profileIds: [ANA, BEN], includeMedia: true });
    const b = await buildViewerExport(deps, { profileIds: [BEN, ANA], includeMedia: true });
    expect(serializeViewerData(a.data)).toBe(serializeViewerData(b.data));
  });

  test('reads past one window', async () => {
    const lib = await createTestLibrary();
    await lib.client.call('createProfile', { id: ANA, displayName: 'Ana', now: NOW });
    const messages = Array.from({ length: 250 }, (_, i) => msg(i + 1, 1 + (i % 28), { ordinal: i }));
    await lib.client.call('importMessages', {
      batchId: uuid(100),
      conversationId: C_ANA,
      source: 'whatsapp',
      sourceLabel: 'x.zip',
      now: NOW,
      blobs: [],
      messages,
      newConversation: { title: 'Big', sourceKey: 'big', isGroup: false, profileIds: [ANA] },
      meAuthor: 'Ana',
    });
    const out = await buildViewerExport(lib.deps, { profileIds: [ANA], includeMedia: false });
    expect(out.data.conversations[0].messages).toHaveLength(250);
  });

  test('rejects an empty selection, bad or reversed dates and an unknown profile', async () => {
    const { deps } = await setup();
    expect(await rejection(buildViewerExport(deps, { profileIds: [], includeMedia: false }))).toMatchObject({ code: 'invalid' });
    expect(await rejection(buildViewerExport(deps, { profileIds: [ANA], from: '01/02/2026', includeMedia: false }))).toMatchObject({ code: 'invalid' });
    expect(await rejection(buildViewerExport(deps, { profileIds: [ANA], from: '2026-02-01', to: '2026-01-01', includeMedia: false }))).toMatchObject({ code: 'invalid' });
    expect(await rejection(buildViewerExport(deps, { profileIds: [uuid(99)], includeMedia: false }))).toMatchObject({ code: 'not-found' });
  });
});
