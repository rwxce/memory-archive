import type { ChangeSet, PackMessage } from '../../domain/changes-pack';
import { sha256Hex } from '../../domain/sha256';
import type { ChangesPackSource } from './write';
import { openChangesPack, readPackLines, type OpenedChangesPack } from './read';
import { RECORD_FILES, batchPath, recordPath, type RecordFileName } from './format';

/** Test helper: a whole pack in memory (synthetic data only). */
export interface UnpackedPack {
  opened: OpenedChangesPack;
  manifest: OpenedChangesPack['manifest'];
  records: Record<RecordFileName, Record<string, unknown>[]>;
  /** Batch id -> [header, ...messages]. */
  batches: Map<string, Record<string, unknown>[]>;
  /** Hashes of the files under blobs/. */
  blobHashes: string[];
}

export async function unpack(zip: Blob): Promise<UnpackedPack> {
  const opened = await openChangesPack(zip, { supportedSchemaVersion: 1_000 });
  const records = {} as UnpackedPack['records'];
  for (const name of RECORD_FILES) {
    records[name] = [];
    for await (const line of readPackLines(zip, opened, recordPath(name))) records[name].push(line);
  }
  const batches = new Map<string, Record<string, unknown>[]>();
  for (const entry of opened.manifest.entries) {
    const match = /^batches\/(.+)\.jsonl$/.exec(entry.path);
    if (!match) continue;
    const lines: Record<string, unknown>[] = [];
    for await (const line of readPackLines(zip, opened, batchPath(match[1]))) lines.push(line);
    batches.set(match[1], lines);
  }
  const blobHashes = opened.manifest.entries.filter((e) => e.path.startsWith('blobs/')).map((e) => e.sha256);
  return { opened, manifest: opened.manifest, records, batches, blobHashes };
}


const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const IDS = { source: uuid(500), target: uuid(501), profile: uuid(1), conversation: uuid(10), batch: uuid(100) };
export const MEDIA = new TextEncoder().encode('synthetic media bytes '.repeat(20));
export const MEDIA_SHA = sha256Hex(MEDIA);
const fp = (n: number) => n.toString(16).padStart(64, '0');

export const MESSAGES: PackMessage[] = [
  { fingerprint: fp(1), sentAt: '2026-01-01T10:00:00', ordinal: 0, type: 'text', author: 'Ana', body: 'synthetic hello', mediaSha256: null, mediaName: '' },
  { fingerprint: fp(2), sentAt: '2026-01-01T10:01:00', ordinal: 0, type: 'photo', author: null, body: '', mediaSha256: MEDIA_SHA, mediaName: 'IMG.jpg' },
];

/** Test helper: a small, valid change set (one of every record) for the writer. */
export function syntheticChangeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    schemaVersion: 8,
    kind: 'changes',
    sourceDeviceId: IDS.source,
    targetDeviceId: IDS.target,
    since: 4,
    upTo: 9,
    ack: 3,
    profiles: [{ id: IDS.profile, displayName: 'Ana', relationship: '', description: '', photoSha256: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', seq: 5 }],
    conversations: [{ id: IDS.conversation, title: 'Chat', source: 'whatsapp', sourceKey: 'chat', isGroup: false, createdAt: '2026-01-01T00:00:00Z', seq: 6, profileIds: [IDS.profile], participants: [{ displayName: 'Ana', profileId: IDS.profile, isMe: false }] }],
    blobs: [{ sha256: MEDIA_SHA, size: MEDIA.length, mime: 'image/jpeg' }],
    favorites: [{ conversationId: IDS.conversation, fingerprint: fp(1), createdAt: '2026-01-02T00:00:00Z', seq: 7 }],
    notes: [{ target: { kind: 'conversation', conversationId: IDS.conversation }, body: 'synthetic note', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', seq: 8 }],
    tombstones: [{ kind: 'favorite', scope: IDS.conversation, key: fp(9), deletedAt: '2026-01-03T00:00:00Z', seq: 9 }],
    batches: [{ id: IDS.batch, conversationId: IDS.conversation, source: 'whatsapp', sourceLabel: 'a.zip', createdAt: '2026-01-01T00:00:00Z', createdConversation: true, seq: 6 }],
    ...overrides,
  };
}

/** Test helper: a writer source over in-memory media and messages. */
export function syntheticSource(changes: ChangeSet = syntheticChangeSet(), extra: Partial<ChangesPackSource> = {}): ChangesPackSource {
  return {
    app: { name: 'memory-archive', version: '1.0.0' },
    createdAt: new Date('2026-05-06T00:00:00Z'),
    changes,
    batchMessages: async function* () {
      yield MESSAGES.slice(0, 1);
      yield MESSAGES.slice(1);
    },
    openBlob: async (sha256) => (sha256 === MEDIA_SHA ? new Blob([MEDIA as BlobPart]).stream() : undefined),
    ...extra,
  };
}
