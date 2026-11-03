import { GENERATOR_NAME, GENERATOR_VERSION } from '../../lib/exporters/legacy/version';
import { VIEWER_DATA_FORMAT, VIEWER_SCHEMA_VERSION, type ViewerConversation, type ViewerData, type ViewerMessage } from '../../lib/exporters/viewer/format';

/** Synthetic viewer data for tests (never real chats). */

export const HASH = 'a'.repeat(64);
export const HASH2 = 'b'.repeat(64);

export function message(overrides: Partial<ViewerMessage> = {}): ViewerMessage {
  return { sentAt: '2024-01-02T10:00:00', type: 'text', author: 'Ada', isMe: false, text: 'hello', media: null, mediaName: '', ...overrides };
}

export function conversation(overrides: Partial<ViewerConversation> = {}): ViewerConversation {
  return {
    id: 'c1',
    title: 'Ada',
    source: 'whatsapp',
    isGroup: false,
    profileIds: ['p1'],
    participants: [{ name: 'Ada', isMe: false }, { name: 'Me', isMe: true }],
    messages: [message()],
    ...overrides,
  };
}

export function viewerData(overrides: Partial<ViewerData> = {}): ViewerData {
  return {
    format: VIEWER_DATA_FORMAT,
    schemaVersion: VIEWER_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    createdAt: '2025-03-01T12:00:00.000Z',
    selection: { from: null, to: null, includeMedia: true },
    profiles: [{ id: 'p1', displayName: 'Ada', relationship: '', description: '' }],
    conversations: [conversation()],
    media: [],
    ...overrides,
  };
}

/** `n` messages, one every 6 hours from 2020-01-01, alternating sides. */
export function manyMessages(n: number, text = (i: number) => `message number ${i}`): ViewerMessage[] {
  const out: ViewerMessage[] = [];
  const start = Date.UTC(2020, 0, 1);
  for (let i = 0; i < n; i++) {
    const d = new Date(start + i * 6 * 3600 * 1000);
    const iso = d.toISOString().slice(0, 19);
    out.push(message({ sentAt: iso, author: i % 2 ? 'Me' : 'Ada', isMe: i % 2 === 1, text: text(i) }));
  }
  return out;
}
