/**
 * The way to a conversation, at a day and, when the local message id is known, at that exact message
 * (`message=`). The date stays in the link so an older build or an unknown message still lands on the day.
 */
export type ConversationBack = 'highlights' | 'favorites';

/** `back=` is a whitelisted name, never a path: anything else is ignored by the conversation screen. */
export function parseBackParam(value: string | null): ConversationBack | null {
  return value === 'highlights' || value === 'favorites' ? value : null;
}

export function conversationHref({ conversationId, personId, sentAt, messageId, back }: { conversationId: string; personId?: string | null; sentAt: string; messageId?: number | null; back?: ConversationBack }): string {
  const from = personId ? `&from=${encodeURIComponent(personId)}` : '';
  const message = messageId === undefined || messageId === null ? '' : `&message=${messageId}`;
  return `/conversation?id=${encodeURIComponent(conversationId)}${from}&date=${sentAt.slice(0, 10)}${message}${back && personId ? `&back=${back}` : ''}`;
}
