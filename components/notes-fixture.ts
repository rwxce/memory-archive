import type { NewMessage } from '@/lib/domain/library';
import { createProfile } from '@/lib/usecases/profiles';
import { getMessageWindow } from '@/lib/usecases/conversation-view';
import type { createTestLibrary } from '@/lib/usecases/test-client';

/** Synthetic data for the notes tests: one person, a chat with four messages and a group with one. */
export type Lib = Awaited<ReturnType<typeof createTestLibrary>>;
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const CHAT = uuid(0x20);
export const GROUP = uuid(0x21);
export const HOSTILE = '<img src=x onerror="window.__pwned=1">';

let counter = 0;
export const msg = (over: Partial<NewMessage> = {}): NewMessage => ({
  fingerprint: (++counter).toString(16).padStart(64, '0'),
  sentAt: `2026-03-17T10:${String(counter).padStart(2, '0')}:00`,
  ordinal: 0,
  type: 'text',
  participantName: 'Bo',
  body: `hello ${counter}`,
  mediaSha256: null,
  mediaName: '',
  ...over,
});

export async function load(lib: Lib, conversationId: string, title: string, personId: string, messages: NewMessage[]) {
  await lib.client.call('importMessages', {
    batchId: uuid(0x100 + counter),
    conversationId,
    source: 'whatsapp',
    sourceLabel: 'x.zip',
    now: '2026-04-01T12:00:00Z',
    blobs: [],
    messages,
    newConversation: { title, sourceKey: conversationId, isGroup: false, profileIds: [personId] },
  });
}

export async function seedNotes(lib: Lib) {
  counter = 0;
  const ana = await createProfile(lib.deps, { displayName: 'Ana M.' });
  await load(lib, CHAT, 'Chat', ana.id, [msg(), msg({ type: 'system', participantName: null, body: 'Messages are encrypted' }), msg({ type: 'deleted', body: '' }), msg({ body: HOSTILE })]);
  await load(lib, GROUP, 'Group', ana.id, [msg({ sentAt: '2026-03-18T09:00:00', body: 'from the group', participantName: 'Eve' })]);
  const ids = async (conversationId: string) => (await getMessageWindow(lib.deps, conversationId, 0, 100)).map((m) => m.id);
  return { ana, chatIds: await ids(CHAT), groupIds: await ids(GROUP) };
}
