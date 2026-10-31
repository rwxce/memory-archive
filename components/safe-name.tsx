import type { ReactNode } from 'react';
import { codePointLength, truncateCodePoints } from '@/lib/domain/photo';

/** Controls, bidi embeddings/overrides/isolates and marks, and zero-width characters: none belongs in a name shown to a person. */
function isHidden(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x61c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** How much of a name a sentence shows, and how much a list row shows. */
export const NAME_IN_SENTENCE = 80;
export const NAME_IN_ROW = 200;

/**
 * A file name, album name or other label from outside, made safe to show: invisible and direction-changing characters
 * removed (so a name cannot reorder the text around it), blanks trimmed, cut by code points with an ellipsis.
 * It is still text only; React escapes it.
 */
export function safeName(text: string, max = NAME_IN_SENTENCE): string {
  let clean = '';
  for (let i = 0; i < text.length; i++) if (!isHidden(text.charCodeAt(i))) clean += text[i];
  clean = clean.trim();
  return codePointLength(clean) > max ? `${truncateCodePoints(clean, max)}…` : clean;
}

/** A name inside a sentence: isolated, so right-to-left text in it cannot flip the words around it, and free to wrap. */
export function nameTag(text: string, max = NAME_IN_SENTENCE): () => ReactNode {
  return () => <bdi className="break-words">{safeName(text, max)}</bdi>;
}
