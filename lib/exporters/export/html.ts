import { renderHtml } from '../legacy/html';
import type { ExportLang } from '../legacy/labels';
import type { ViewerConversation, ViewerData } from '../viewer/format';
import { toRenderInput } from './messages';

/**
 * One self-contained transcript page for a conversation: the legacy renderer (escaping, CSP with
 * script hashes, no network), fed from viewer data. Media are referenced as `media/<sha256>.<ext>`
 * relative to the page.
 */
export function renderConversationHtml(conversation: ViewerConversation, data: ViewerData, lang: ExportLang): Promise<string> {
  const input = toRenderInput(conversation, data.media);
  return renderHtml(input.messages, conversation.title, { media: input.media, me: input.me, lang });
}
