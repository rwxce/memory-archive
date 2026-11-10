import { photoDisplayDate } from '../../domain/photo';
import { escapeMd } from '../legacy/js/linkify.js';
import { type ExportLang, formatDay, labelsFor } from '../legacy/labels';
import type { ViewerPhoto, ViewerProfile } from '../viewer/format';

/**
 * The per-person photos page of the `html` and `markdown` exports (docs/formats/export-package.md):
 * one file per profile that has assigned photos, linking the files in `media/` by relative path.
 * Pure. The profile name, file names and album names are untrusted: escaped here, and never part of a
 * path (links are `media/<sha256>.<ext>`, validated by `parseViewerData`).
 */

const LABELS: Record<ExportLang, { photos: string; video: string; albums: string; dateUnknown: string; open: string }> = {
  ca: { photos: 'Fotos', video: 'Vídeo', albums: 'Àlbums', dateUnknown: 'Sense data', open: 'Obre' },
  es: { photos: 'Fotos', video: 'Vídeo', albums: 'Álbumes', dateUnknown: 'Sin fecha', open: 'Abrir' },
  en: { photos: 'Photos', video: 'Video', albums: 'Albums', dateUnknown: 'No date', open: 'Open' },
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The picture's day in the language's long format, `≈` in front of a guessed date; a label when unknown. */
function shownDate(photo: ViewerPhoto, lang: ExportLang): string {
  const date = photoDisplayDate(photo);
  if (date === null) return LABELS[lang].dateUnknown;
  return `${date.approximate ? '≈ ' : ''}${formatDay(date.day, labelsFor(lang).locale)}`;
}

export function photosTitle(profile: ViewerProfile, lang: ExportLang): string {
  return `${LABELS[lang].photos} - ${oneLine(profile.displayName)}`;
}

export function renderPhotosHtml(profile: ViewerProfile, photos: ViewerPhoto[], lang: ExportLang): string {
  const l = LABELS[lang];
  const title = escapeHtml(photosTitle(profile, lang));
  const items = photos.map((p) => {
    const name = escapeHtml(oneLine(p.fileName));
    const href = escapeHtml(p.path);
    const media =
      p.kind === 'video'
        ? `<video src="${href}" controls preload="none" aria-label="${name}"></video>`
        : `<a href="${href}"><img src="${href}" alt="${name}" loading="lazy"></a>`;
    const albums = p.albums.length > 0 ? `<br>${escapeHtml(l.albums)}: ${escapeHtml(p.albums.map(oneLine).join(', '))}` : '';
    const label = p.kind === 'video' ? `${escapeHtml(l.video)}: ` : '';
    return `<li>${media}<p>${label}<a href="${href}">${name || escapeHtml(l.open)}</a><br><time>${escapeHtml(shownDate(p, lang))}</time>${albums}</p></li>`;
  });
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${title}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:72rem;margin-inline:auto}
ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}
li img,li video{display:block;width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;background:#8884}
li p{margin:4px 0 0;font-size:.875rem;overflow-wrap:anywhere}
</style>
</head>
<body>
<h1>${title}</h1>
<ul>
${items.join('\n')}
</ul>
</body>
</html>
`;
}

export function renderPhotosMarkdown(profile: ViewerProfile, photos: ViewerPhoto[], lang: ExportLang): string {
  const l = LABELS[lang];
  const lines = [`# ${escapeMd(photosTitle(profile, lang))}`, ''];
  for (const p of photos) {
    const name = escapeMd(oneLine(p.fileName)) || escapeMd(l.open);
    const albums = p.albums.length > 0 ? ` - ${l.albums}: ${escapeMd(p.albums.map(oneLine).join(', '))}` : '';
    const prefix = p.kind === 'video' ? `${l.video}: ` : '';
    lines.push(`- ${prefix}[${name}](${p.path}) - ${escapeMd(shownDate(p, lang))}${albums}`);
    if (p.kind === 'photo') lines.push(`  ![${name}](${p.path})`);
  }
  return lines.join('\n') + '\n';
}
