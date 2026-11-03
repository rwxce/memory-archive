import { MESSAGE_TYPES } from '../../domain/library';
import type { Message, MessageType } from '../../importers/whatsapp/types';
import { mimeFromExt, type MediaEntry, extOf } from '../legacy/media';
import type { ViewerConversation, ViewerData } from '../viewer/format';

/**
 * Adapts a viewer-data conversation to the legacy renderers' input (`Message[]` + media map), so
 * the HTML and Markdown exports share their escaping, linkification and transcript layout instead
 * of duplicating them. Pure.
 */

export interface RenderInput {
  messages: Message[];
  media: Map<string, MediaEntry>;
  /** The export owner's name in this conversation, when known. */
  me: string | undefined;
}

const isType = (value: string): value is MessageType => (MESSAGE_TYPES as readonly string[]).includes(value);

export function toRenderInput(conversation: ViewerConversation, files: ViewerData['media']): RenderInput {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const media = new Map<string, MediaEntry>();
  const messages: Message[] = conversation.messages.map((m) => {
    let key = m.mediaName;
    if (m.media !== null) {
      const file = byPath.get(m.media);
      // The original name labels the file; if two files share a name, the later one is keyed by its path.
      if (key === '' || (media.has(key) && media.get(key)?.relPath !== m.media)) key = m.media;
      if (!media.has(key)) {
        const mime = file?.mime ?? mimeFromExt(extOf(m.media));
        media.set(key, { relPath: m.media, mime, inlineable: false, size: file?.size ?? 0 });
      }
    }
    // A file that is not included must not resolve to an included file that has the same name.
    if (m.media === null && key !== '' && media.has(key)) key = `${key} (missing)`;
    return {
      timestamp_iso: m.sentAt,
      type: isType(m.type) ? m.type : 'text',
      author: m.author ?? '',
      text: m.text,
      media: key,
    };
  });
  return { messages, media, me: conversation.participants.find((p) => p.isMe)?.name };
}
