import type { PhotoKind } from '../../domain/photo';
import { mediaTypeOf } from '../takeout/paths';

/**
 * What a file really is, decided by its first bytes, never by `File.type` (the browser derives that
 * from the extension) or the name alone. Only the formats the photo collection keeps; anything else
 * (HTML, a script, RAW, a document) is `null`. Pure, no I/O. `docs/formats/photo-library.md`.
 */

export interface SniffedMedia {
  kind: PhotoKind;
  mime: string;
  /** Which EXIF reader applies: a JPEG's APP1 segment, a HEIF file's `Exif` item, or none. */
  exif: 'jpeg' | 'heif' | null;
}

/** Bytes needed to tell every format below apart. */
export const SNIFF_BYTES = 64;

const startsWith = (b: Uint8Array, at: number, text: string): boolean => {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/** `ftyp` brands of audio, RAW or other image formats we do not keep: refused, never taken for MP4 video. */
const REFUSED_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ', 'crx ', 'jp2 ', 'jpx ', 'jpm ', 'mjp2']);

/** ISO base media `ftyp` major brand to a type. Unknown brands of a video container are plain MP4. */
function fromBrand(brand: string): SniffedMedia | null {
  if (REFUSED_BRANDS.has(brand)) return null;
  if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return { kind: 'photo', mime: 'image/heic', exif: 'heif' };
  if (['mif1', 'msf1', 'heif', 'avci'].includes(brand)) return { kind: 'photo', mime: 'image/heif', exif: 'heif' };
  if (brand === 'avif' || brand === 'avis') return { kind: 'photo', mime: 'image/avif', exif: null };
  if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime', exif: null };
  if (brand.startsWith('3gp') || brand.startsWith('3g2')) return { kind: 'video', mime: 'video/3gpp', exif: null };
  if (brand === 'M4V ') return { kind: 'video', mime: 'video/x-m4v', exif: null };
  return { kind: 'video', mime: 'video/mp4', exif: null };
}

/** The type the first bytes say, or null when they are not a picture or video we keep. */
export function sniffMedia(head: Uint8Array): SniffedMedia | null {
  if (head.length < 12) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'photo', mime: 'image/jpeg', exif: 'jpeg' };
  if (startsWith(head, 0, '\x89PNG\r\n\x1a\n')) return { kind: 'photo', mime: 'image/png', exif: null };
  if (startsWith(head, 0, 'GIF87a') || startsWith(head, 0, 'GIF89a')) return { kind: 'photo', mime: 'image/gif', exif: null };
  if (startsWith(head, 0, 'RIFF')) {
    if (startsWith(head, 8, 'WEBP')) return { kind: 'photo', mime: 'image/webp', exif: null };
    if (startsWith(head, 8, 'AVI ')) return { kind: 'video', mime: 'video/x-msvideo', exif: null };
    return null;
  }
  if (startsWith(head, 0, 'BM')) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    // Two letters are not proof: the reserved fields are zero and the info header has a known size.
    if (view.getUint32(6, true) === 0 && head.length >= 18 && BMP_DIB_SIZES.has(view.getUint32(14, true))) {
      return { kind: 'photo', mime: 'image/bmp', exif: null };
    }
    return null;
  }
  if ((startsWith(head, 0, 'II') && head[2] === 0x2a && head[3] === 0) || (startsWith(head, 0, 'MM') && head[2] === 0 && head[3] === 0x2a)) {
    return { kind: 'photo', mime: 'image/tiff', exif: null };
  }
  if (startsWith(head, 4, 'ftyp')) {
    let brand = '';
    for (let i = 8; i < 12; i++) brand += String.fromCharCode(head[i]);
    return fromBrand(brand);
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    // EBML header: the DocType ("webm" or "matroska") sits in the first bytes.
    for (let i = 4; i + 4 <= Math.min(head.length, SNIFF_BYTES); i++) if (startsWith(head, i, 'webm')) return { kind: 'video', mime: 'video/webm', exif: null };
    return { kind: 'video', mime: 'video/x-matroska', exif: null };
  }
  if (head[0] === 0 && head[1] === 0 && head[2] === 1 && (head[3] === 0xba || head[3] === 0xb3)) return { kind: 'video', mime: 'video/mpeg', exif: null };
  return null;
}

/** What a file name's extension says: `other` is a name with an extension that is not a picture or video we keep. */
export function extensionVerdict(baseName: string): 'photo' | 'video' | 'none' | 'other' {
  const dot = baseName.lastIndexOf('.');
  if (dot <= 0) return 'none';
  return mediaTypeOf(baseName)?.kind ?? 'other';
}

/**
 * A file is kept only when its BYTES are a picture or video we keep and its name does not say
 * otherwise: an extension that is not a media one (`.html`, `.exe`) or that names the other kind
 * (a `.mp4` holding a JPEG) refuses it. A missing extension is fine (the bytes decide), and
 * `.jpg` holding a PNG is kept as the PNG it is. The returned type is the bytes' own.
 */
export function acceptMedia(baseName: string, head: Uint8Array): SniffedMedia | null {
  const sniffed = sniffMedia(head);
  if (!sniffed) return null;
  const verdict = extensionVerdict(baseName);
  if (verdict === 'other' || ((verdict === 'photo' || verdict === 'video') && verdict !== sniffed.kind)) return null;
  return sniffed;
}
