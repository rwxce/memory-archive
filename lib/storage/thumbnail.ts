/**
 * Makes a small picture from a photo, off the main thread where the browser allows it:
 * `createImageBitmap` decodes (and downsizes while decoding, so a 50 MP photo is never held at
 * full size) and `OffscreenCanvas.convertToBlob` encodes. Pure platform APIs, no DOM element.
 *
 * It never throws: a picture the browser cannot decode (HEIC on most browsers, a damaged file, a
 * video) or a browser without these APIs gives `undefined`, and the caller keeps showing the
 * original. The result is webp where the browser can encode it, else jpeg.
 */

const WEBP = 'image/webp';
const JPEG = 'image/jpeg';
const QUALITY = 0.8;
/** The first decode only learns the picture's orientation; it is tiny. Both decodes pass `imageOrientation: 'from-image'` (EXIF) explicitly, so no engine default matters. */
const PROBE_WIDTH = 64;

interface BitmapLike {
  width: number;
  height: number;
  close(): void;
}

interface CanvasLike {
  getContext(kind: '2d'): {
    drawImage(image: never, x: number, y: number): void;
    fillRect(x: number, y: number, width: number, height: number): void;
    fillStyle: unknown;
    globalCompositeOperation: string;
  } | null;
  convertToBlob(options: { type: string; quality: number }): Promise<Blob>;
}

/** The browser APIs used; injected in tests (happy-dom has neither). */
export interface ThumbnailEnvironment {
  createImageBitmap?: (
    blob: Blob,
    options: { resizeWidth?: number; resizeHeight?: number; resizeQuality?: string; imageOrientation?: string },
  ) => Promise<BitmapLike>;
  OffscreenCanvas?: new (width: number, height: number) => CanvasLike;
}

export async function makeThumbnail(
  blob: Blob,
  maxSide: number,
  env: ThumbnailEnvironment = globalThis as unknown as ThumbnailEnvironment,
): Promise<Blob | undefined> {
  const { createImageBitmap, OffscreenCanvas } = env;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return undefined;
  let bitmap: BitmapLike | undefined;
  try {
    const probe = await createImageBitmap(blob, { resizeWidth: PROBE_WIDTH, resizeQuality: 'low', imageOrientation: 'from-image' });
    const portrait = probe.height > probe.width;
    probe.close();
    // The longer side becomes `maxSide`; the other follows the picture's own proportions.
    bitmap = await createImageBitmap(blob, { ...(portrait ? { resizeHeight: maxSide } : { resizeWidth: maxSide }), resizeQuality: 'medium', imageOrientation: 'from-image' });
    if (!(bitmap.width > 0) || !(bitmap.height > 0)) return undefined;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(bitmap as never, 0, 0);
    const webp = await canvas.convertToBlob({ type: WEBP, quality: QUALITY });
    if (webp.type === WEBP) return webp;
    // jpeg has no transparency: put the picture on white instead of black.
    context.globalCompositeOperation = 'destination-over';
    context.fillStyle = '#fff';
    context.fillRect(0, 0, bitmap.width, bitmap.height);
    const jpeg = await canvas.convertToBlob({ type: JPEG, quality: QUALITY });
    return jpeg.type === JPEG ? jpeg : undefined;
  } catch {
    return undefined;
  } finally {
    bitmap?.close();
  }
}
