import { createHash } from 'node:crypto';

/**
 * Deterministic per-sender accent color (D-32).
 *
 * SHA256 of the author name -> first 4 bytes -> uint32 -> modulo 360 degrees.
 * Same author always maps to the same hue; distinct authors are visually
 * separated because the hash space is uniform.
 */
export function accentHue(author: string): number {
  const hash = createHash('sha256').update(author, 'utf8').digest();
  const int = hash.readUInt32BE(0);
  return int % 360;
}

export function getAccentColor(author: string): string {
  return `hsl(${accentHue(author)}, 70%, 60%)`;
}

/** Short initials for avatar chips (D-38). */
export function initials(author: string): string {
  const cleaned = author.replace(/[~‪‫]/g, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
