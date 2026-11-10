import { GENERATOR_NAME, GENERATOR_VERSION } from '../legacy/version';
import { VIEWER_DATA_FORMAT, VIEWER_SCHEMA_VERSION, type ViewerConversation, type ViewerData, type ViewerMedia, type ViewerMessage, type ViewerPhoto, type ViewerProfile, viewerMediaPath } from './format';

/**
 * Assembles `ViewerData` from already-read rows. Pure: the use case reads the library and decides
 * which files exist; this only shapes and orders, so the same input always gives the same bytes.
 */

export interface ViewerSourceMessage {
  sentAt: string;
  type: string;
  participantName: string | null;
  isMe: boolean;
  body: string;
  mediaSha256: string | null;
  mediaName: string;
  mediaMime: string | null;
}

export interface ViewerSourceConversation {
  id: string;
  title: string;
  source: string;
  isGroup: boolean;
  profileIds: string[];
  participants: { displayName: string; isMe: boolean }[];
  messages: ViewerSourceMessage[];
}

/** A picture assigned to a profile, before its bytes are known to be available. */
export type ViewerSourcePhoto = Omit<ViewerPhoto, 'path'>;

export interface BuildViewerInput {
  now: string;
  from: string | null;
  to: string | null;
  includeMedia: boolean;
  profiles: ViewerProfile[];
  conversations: ViewerSourceConversation[];
  /** Hashes whose bytes are in the blob store, with their size; others count as missing. */
  availableMedia: ReadonlyMap<string, number>;
  /**
   * Pictures per profile id (already filtered by the use case). Present only when the export has
   * media: a profile then gets `photos`, with the pictures whose bytes are available.
   */
  photos?: ReadonlyMap<string, ViewerSourcePhoto[]>;
}

export function buildViewerData(input: BuildViewerInput): ViewerData {
  const media = new Map<string, ViewerMedia>();
  const conversations: ViewerConversation[] = input.conversations.map((c) => ({
    id: c.id,
    title: c.title,
    source: c.source,
    isGroup: c.isGroup,
    profileIds: [...c.profileIds].sort(),
    participants: c.participants.map((p) => ({ name: p.displayName, isMe: p.isMe })),
    messages: c.messages.map((m): ViewerMessage => {
      let path: string | null = null;
      const size = m.mediaSha256 === null ? undefined : input.availableMedia.get(m.mediaSha256);
      if (input.includeMedia && m.mediaSha256 !== null && size !== undefined) {
        const known = media.get(m.mediaSha256);
        path = known?.path ?? viewerMediaPath(m.mediaSha256, { name: m.mediaName, mime: m.mediaMime });
        if (!known) media.set(m.mediaSha256, { sha256: m.mediaSha256, path, size, mime: m.mediaMime });
      }
      return { sentAt: m.sentAt, type: m.type, author: m.participantName, isMe: m.isMe, text: m.body, media: path, mediaName: m.mediaName };
    }),
  }));
  const profiles = input.photos
    ? input.profiles.map((p): ViewerProfile => {
        const photos: ViewerPhoto[] = [];
        for (const ph of input.photos?.get(p.id) ?? []) {
          const size = input.availableMedia.get(ph.sha256);
          if (size === undefined) continue;
          const known = media.get(ph.sha256);
          const path = known?.path ?? viewerMediaPath(ph.sha256, { name: ph.fileName, mime: ph.mime });
          if (!known) media.set(ph.sha256, { sha256: ph.sha256, path, size, mime: ph.mime });
          photos.push({ ...ph, path });
        }
        return { ...p, photos };
      })
    : input.profiles;
  return {
    format: VIEWER_DATA_FORMAT,
    schemaVersion: VIEWER_SCHEMA_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    createdAt: input.now,
    selection: { from: input.from, to: input.to, includeMedia: input.includeMedia },
    profiles,
    conversations,
    media: [...media.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1)),
  };
}
