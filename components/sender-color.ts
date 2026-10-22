import { sha256Hex } from '@/lib/domain/sha256';

const encoder = new TextEncoder();
const hues = new Map<string, number>();

/**
 * A fixed hue (0-359) per author name: the first 4 bytes of the SHA-256 of the name, modulo 360,
 * like the standalone viewer, so the same person has the same color in both. The page turns it
 * into a color that is readable on the bubble in the light and the dark theme.
 */
export function senderHue(name: string): number {
  let hue = hues.get(name);
  if (hue === undefined) {
    hue = parseInt(sha256Hex(encoder.encode(name)).slice(0, 8), 16) % 360;
    if (hues.size > 2000) hues.clear();
    hues.set(name, hue);
  }
  return hue;
}
