import { senderHue } from './sender-color';

/**
 * The eight avatar tints of the palette (`--ph-0` .. `--ph-7`, light and dark values live in
 * globals.css). Literal class names, so Tailwind sees them.
 */
export const AVATAR_TINTS = ['bg-ph-0', 'bg-ph-1', 'bg-ph-2', 'bg-ph-3', 'bg-ph-4', 'bg-ph-5', 'bg-ph-6', 'bg-ph-7'] as const;

/** A fixed tint (0-7) per name, so the same person looks the same on every screen. */
export function tintIndex(name: string): number {
  return senderHue(name) % AVATAR_TINTS.length;
}

/** The first letter of a name, upper-cased, by whole characters (never half an emoji); "?" when blank. */
export function avatarLetter(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : '?';
}
