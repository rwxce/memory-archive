/** Test helper: a structurally complete webp of `total` bytes (RIFF header with the right length, then filler). */
export function webpBlob(total: number, fill = 1): Blob {
  const bytes = new Uint8Array(total).fill(fill);
  bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  new DataView(bytes.buffer).setUint32(4, total - 8, true);
  bytes.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
  return new Blob([bytes], { type: 'image/webp' });
}
