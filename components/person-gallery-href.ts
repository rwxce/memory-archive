import type { PersonMediaItem } from '@/lib/domain/library';

/** Where a gallery item lives: its message in its conversation, on that day, coming from the person. */
export function galleryItemHref(item: PersonMediaItem, personId: string): string {
  return `/conversation?id=${encodeURIComponent(item.conversationId)}&from=${encodeURIComponent(personId)}&date=${item.sentAt.slice(0, 10)}`;
}
