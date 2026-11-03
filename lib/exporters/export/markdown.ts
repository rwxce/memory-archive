import { renderMarkdown } from '../legacy/md';
import type { ExportLang } from '../legacy/labels';
import type { ViewerConversation, ViewerData } from '../viewer/format';
import { toRenderInput } from './messages';

/**
 * One Markdown file for a conversation (legacy renderer: day sections, `escapeMd` on every piece of
 * untrusted text, the title on one line, link targets restricted to http(s) and `media/<name>`).
 */
export function renderConversationMarkdown(conversation: ViewerConversation, data: ViewerData, lang: ExportLang): Promise<string> {
  const input = toRenderInput(conversation, data.media);
  return renderMarkdown(input.messages, conversation.title.replace(/\s+/g, ' ').trim(), { media: input.media, lang });
}
