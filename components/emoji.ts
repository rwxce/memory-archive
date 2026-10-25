const TEXT_DEFAULT_EMOJI = /\p{Emoji}(?![︎️‍⃣\u{1F3FB}-\u{1F3FF}])/gu;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
/** Digits, # and * are Emoji too, and ©, ® and ™ are almost always meant as text. */
const KEEP_AS_TEXT = /^[\u0000-\u007F©®™]$/u;

/**
 * Display only: asks for the colour glyph of emoji that default to text (a bare U+2764 heart shows
 * as a monochrome character in several browsers) by appending U+FE0F. Never use the result for
 * storage, search or comparison.
 */
export function withEmojiPresentation(text: string): string {
  return text.replace(TEXT_DEFAULT_EMOJI, (char) => (EMOJI_PRESENTATION.test(char) || KEEP_AS_TEXT.test(char) ? char : `${char}️`));
}
