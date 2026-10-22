import { describe, expect, test } from 'vitest';
import { makeThumbnail, type ThumbnailEnvironment } from './thumbnail';

const photo = new Blob([new Uint8Array(10)], { type: 'image/jpeg' });

/** createImageBitmap/OffscreenCanvas fakes: a picture of `width` x `height`, scaled like the browser does. */
function fakes(width: number, height: number, options: { encodes?: string[]; failDecode?: boolean } = {}) {
  const encodes = options.encodes ?? ['image/webp', 'image/jpeg'];
  const bitmaps: { width: number; height: number; closed: boolean }[] = [];
  const requests: unknown[] = [];
  const drawn: string[] = [];
  const env: ThumbnailEnvironment = {
    createImageBitmap: async (_blob, resize) => {
      requests.push(resize);
      // Both decodes must ask for the picture's own orientation (EXIF), not rely on a default.
      expect(resize.imageOrientation).toBe('from-image');
      if (options.failDecode) throw new DOMException('cannot decode', 'InvalidStateError');
      const scale = resize.resizeWidth ? resize.resizeWidth / width : resize.resizeHeight! / height;
      const bitmap = { width: Math.round(width * scale), height: Math.round(height * scale), closed: false, close() { bitmap.closed = true; } };
      bitmaps.push(bitmap);
      return bitmap;
    },
    OffscreenCanvas: class {
      constructor(public width: number, public height: number) {}
      getContext() {
        return {
          drawImage: () => drawn.push('image'),
          fillRect: () => drawn.push('white'),
          fillStyle: '',
          globalCompositeOperation: 'source-over',
        };
      }
      async convertToBlob({ type, quality }: { type: string; quality: number }) {
        return new Blob([`${type}:${quality}:${this.width}x${this.height}`], { type: encodes.includes(type) ? type : 'image/png' });
      }
    },
  };
  return { env, bitmaps, requests, drawn };
}

describe('makeThumbnail', () => {
  test('a landscape photo becomes a webp with its longest side at the limit, and every bitmap is closed', async () => {
    const { env, bitmaps, requests } = fakes(4000, 3000);
    const thumb = await makeThumbnail(photo, 320, env);
    expect(thumb?.type).toBe('image/webp');
    expect(await thumb!.text()).toBe('image/webp:0.8:320x240');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ resizeWidth: 320 });
    expect(bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
  });

  test('a portrait photo is limited by its height', async () => {
    const { env, requests } = fakes(3000, 4000);
    const thumb = await makeThumbnail(photo, 320, env);
    expect(await thumb!.text()).toBe('image/webp:0.8:240x320');
    expect(requests[1]).toMatchObject({ resizeHeight: 320 });
  });

  test('without webp encoding it falls back to jpeg on a white background', async () => {
    const { env, drawn } = fakes(800, 600, { encodes: ['image/jpeg'] });
    const thumb = await makeThumbnail(photo, 320, env);
    expect(thumb?.type).toBe('image/jpeg');
    expect(drawn).toEqual(['image', 'white']);
  });

  test('no encoder at all gives undefined', async () => {
    expect(await makeThumbnail(photo, 320, fakes(800, 600, { encodes: [] }).env)).toBeUndefined();
  });

  test('an undecodable picture gives undefined, never an error', async () => {
    const { env, bitmaps } = fakes(1, 1, { failDecode: true });
    expect(await makeThumbnail(photo, 320, env)).toBeUndefined();
    expect(bitmaps).toHaveLength(0);
  });

  test('a bitmap is closed even when encoding fails', async () => {
    const { env, bitmaps } = fakes(800, 600);
    const Canvas = env.OffscreenCanvas!;
    env.OffscreenCanvas = class extends Canvas {
      async convertToBlob(): Promise<Blob> {
        throw new Error('boom');
      }
    };
    expect(await makeThumbnail(photo, 320, env)).toBeUndefined();
    expect(bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
  });

  test('a browser without the APIs gives undefined', async () => {
    expect(await makeThumbnail(photo, 320, {})).toBeUndefined();
    const { env } = fakes(800, 600);
    expect(await makeThumbnail(photo, 320, { ...env, OffscreenCanvas: undefined })).toBeUndefined();
  });

  test('uses the global APIs by default and tolerates their absence (happy-dom and Node have neither)', async () => {
    expect(await makeThumbnail(photo, 320)).toBeUndefined();
  });
});
