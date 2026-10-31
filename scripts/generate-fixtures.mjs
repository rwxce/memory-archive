// Generates synthetic, non-personal WhatsApp export fixtures into ./fixtures
// so the test-suite can run in CI without the developer's real (gitignored)
// `data/` folder. The content reproduces the demo strings the assertions pin
// but contains no personal conversations.
//
// Run by `pnpm test` (and `pnpm smoke`) before the suite.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { writeShowcase } from './showcase-fixtures.mjs';
import { writeTakeoutFixtures } from './takeout-fixtures.mjs';

const ROOT = process.cwd();
const FIXTURES = path.join(ROOT, 'fixtures');

const NOTAS = 'WhatsApp Chat - Notas pessoais';
const ORG = 'WhatsApp Chat - Example Org';

// 17 media files referenced by the reconcileMedia test (basenames only).
const NOTAS_MEDIA = [
  '00000008-STICKER-2020-04-03-15-17-12.webp',
  '00000021-STICKER-2020-04-10-21-58-01.webp',
  '00000023-STICKER-2020-04-11-13-24-21.webp',
  '00000040-STICKER-2020-04-20-15-16-33.webp',
  '00000045-STICKER-2020-04-23-23-19-31.webp',
  '00000068-Conversa do WhatsApp com Notas pessoais.zip',
  '00000088-STICKER-2020-05-27-08-45-13.webp',
  '00000089-VIDEO-2020-05-27-17-26-38.mp4',
  '00000091-PHOTO-2020-05-29-17-23-37.jpg',
  '00000098-PHOTO-2020-06-10-13-55-47.jpg',
  '00000099-STICKER-2020-06-10-13-55-59.webp',
  '00000134-PHOTO-2020-07-18-22-34-29.jpg',
  '00000147-PHOTO-2020-07-26-19-23-49.jpg',
  '00000148-PHOTO-2020-07-28-07-48-08.jpg',
  '00000149-PHOTO-2020-07-28-07-48-50.jpg',
  '00000152-12345678900-DOC-D-0-0211-31-07-2020-08-03.pdf',
  '00000153-raw.pdf',
];

const ORG_MEDIA = [
  '00003010-STICKER-2020-07-23-12-41-49.webp',
  '00003036-PHOTO-2020-07-23-23-31-30.jpg',
  '00003046-PHOTO-2020-07-24-10-41-01.jpg',
  '00003046-PHOTO-2020-07-24-10-41-02.jpg',
  '00003046-PHOTO-2020-07-24-10-41-03.jpg',
  '00003046-PHOTO-2020-07-24-10-41-04.jpg',
  '00003046-PHOTO-2020-07-24-10-41-05.jpg',
];

// Tiny placeholder bytes so the files exist for media reconciliation.
const PLACEHOLDER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// iOS-bracketed format: [DD/MM/YYYY HH:MM:SS] Sender: body
const NOTAS_TXT = [
  '[17/03/2020 13:17:59] Alice Example: https://lefthook.dev/',
  '[20/03/2020 16:20:22] Alice Example: image omitted',
  '[25/03/2020 19:52:16] Alice Example: Mensagem apagada',
  '[25/03/2020 19:52:29] Alice Example: sticker omitted',
  '[28/03/2020 07:15:45] Alice Example: sample_document.pdf document omitted',
  '[03/04/2020 15:17:12] Alice Example: <attached: 00000008-STICKER-2020-04-03-15-17-12.webp>',
  '[29/05/2020 17:23:37] Alice Example: Example caption <attached: 00000091-PHOTO-2020-05-29-17-23-37.jpg>',
  '[30/07/2020 21:44:36] Alice Example: <attached: 00000152-12345678900-DOC-D-0-0211-31-07-2020-08-03.pdf> 12345678900-DOC-D-0-0211-31-07-2020-08-03.pdf • ‎1 página',
  // 4 empty-body + same-author attachment pairs (merge into one media row each)
  // to balance the dedupe assertion (excluded omitted/deleted == merges).
  '[10/04/2020 10:00:00] Alice Example:',
  '[10/04/2020 10:00:01] Alice Example: <attached: 00000021-STICKER-2020-04-10-21-58-01.webp>',
  '[11/04/2020 10:00:00] Alice Example:',
  '[11/04/2020 10:00:01] Alice Example: <attached: 00000023-STICKER-2020-04-11-13-24-21.webp>',
  '[20/04/2020 10:00:00] Alice Example:',
  '[20/04/2020 10:00:01] Alice Example: <attached: 00000040-STICKER-2020-04-20-15-16-33.webp>',
  '[23/04/2020 10:00:00] Alice Example:',
  '[23/04/2020 10:00:01] Alice Example: <attached: 00000045-STICKER-2020-04-23-23-19-31.webp>',
].join('\n') + '\n';

const ORG_TXT = [
  '[23/07/2020 09:47:18] Example Org: Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.',
  '[23/07/2020 12:15:28] +00 555 0100 1234: Olá equipe',
  '[23/07/2020 12:41:48] Alice Example: <attached: 00003010-STICKER-2020-07-23-12-41-49.webp>',
  '[23/07/2020 23:31:29] Carol Sample:',
  '[23/07/2020 23:31:30] Carol Sample: <attached: 00003036-PHOTO-2020-07-23-23-31-30.jpg>',
  '[23/07/2020 12:42:00] Alice Example: Wi-Fi: Example Network',
  'Password: example-password',
  '[23/07/2020 18:00:00] Alice Example: Mensagem apagada',
  '[23/07/2020 12:50:00] Alice Example: sticker omitted',
  '[24/07/2020 10:41:01] Bob Sample: <attached: 00003046-PHOTO-2020-07-24-10-41-01.jpg>',
  '[24/07/2020 10:41:02] Bob Sample: <attached: 00003046-PHOTO-2020-07-24-10-41-02.jpg>',
  '[24/07/2020 10:41:03] Bob Sample: <attached: 00003046-PHOTO-2020-07-24-10-41-03.jpg>',
  '[24/07/2020 10:41:04] Bob Sample: <attached: 00003046-PHOTO-2020-07-24-10-41-04.jpg>',
  '[24/07/2020 10:41:05] Bob Sample: <attached: 00003046-PHOTO-2020-07-24-10-41-05.jpg>',
  // empty-body + same-author attachment pair (merges into one media row) to
  // balance the dedupe assertion (excluded omitted/deleted == merges).
  '[23/07/2020 19:00:00] Alice Example:',
  '[23/07/2020 19:00:01] Alice Example: <attached: 00003010-STICKER-2020-07-23-12-41-49.webp>',
  '[20/08/2020 10:00:00] Example Org: última mensagem do período',
].join('\n') + '\n';

// ---------------------------------------------------------------------------
// Format fixtures: one synthetic chat per export style/locale. Real exports
// keep the transcript and the media at the ZIP ROOT (iOS: `_chat.txt`; Android: `<localized> <name>.txt`, here ES/PT/CA) (the chat name comes from the
// ZIP file name), so these are built that way. Names and content are made up.
// ---------------------------------------------------------------------------

const NNBSP = '\u202f'; // narrow no-break space iOS puts before AM/PM
const NBSP = '\u00a0';
const LRM = '\u200e'; // iOS marks system lines and media placeholders with it

/** Android, en-US: M/D/YY, 12h `AM`/`PM`, ` - ` separator, `(file attached)`. */
const ANDROID_US = {
  zip: 'WhatsApp Chat - Android US.zip',
  media: [
    'IMG-20260101-WA0001.jpg',
    'VID-20260101-WA0002.mp4',
    'PTT-20260101-WA0003.opus',
    'STK-20260101-WA0004.webp',
  ],
  txt: [
    '12/31/25, 11:58 PM - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them. Tap to learn more.',
    '12/31/25, 11:59 PM - Ana Lima created group "Family 2026"',
    '12/31/25, 11:59 PM - Ana Lima added Bo Chen',
    '1/1/26, 12:00 AM - Ana Lima: Happy new year!',
    '1/1/26, 12:01 AM - Bo Chen: Thanks!',
    'This is a second line',
    '',
    'and a third one after a blank line',
    '1/1/26, 12:05 AM - Bo Chen: <Media omitted>',
    '1/1/26, 9:41 AM - Ana Lima: IMG-20260101-WA0001.jpg (file attached)',
    '1/1/26, 9:41 AM - Ana Lima: VID-20260101-WA0002.mp4 (file attached)',
    'Look at this',
    '1/1/26, 9:42 AM - Bo Chen: PTT-20260101-WA0003.opus (file attached)',
    '1/1/26, 9:43 AM - Bo Chen: STK-20260101-WA0004.webp (file attached)',
    '1/1/26, 9:44 AM - Ana Lima: This message was deleted',
    '1/1/26, 9:45 AM - Bo Chen: You deleted this message',
    '1/1/26, 12:30 PM - Ana Lima: ok',
    '1/1/26, 12:30 PM - Ana Lima: ok',
    '1/13/26, 1:15 PM - Bo Chen: The 13th makes the month-first order unambiguous',
  ].join('\n') + '\n',
};

/** iOS, en-US: `[M/D/YY, h:mm:ss<U+202F>AM]`, group-name sender for system lines. */
const IOS_US_LINES = (withMedia) => [
  `[1/2/26, 9:00:00${NNBSP}AM] Family 2026: ${LRM}Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.`,
  `[1/2/26, 9:00:01${NNBSP}AM] Family 2026: ${LRM}Ana Lima created this group`,
  `[1/2/26, 9:05:01${NNBSP}AM] Ana Lima: Good morning`,
  `[1/2/26, 9:05:30${NNBSP}AM] Bo Chen: Morning!`,
  'Coffee?',
  withMedia
    ? `${LRM}[1/2/26, 9:06:00${NNBSP}AM] Bo Chen: ${LRM}<attached: 00000005-PHOTO-2026-01-02-09-06-00.jpg>`
    : `${LRM}[1/2/26, 9:06:00${NNBSP}AM] Bo Chen: ${LRM}image omitted`,
  withMedia
    ? `${LRM}[1/2/26, 9:07:00${NNBSP}AM] Ana Lima: ${LRM}<attached: 00000006-AUDIO-2026-01-02-09-07-00.opus>`
    : `${LRM}[1/2/26, 9:07:00${NNBSP}AM] Ana Lima: ${LRM}audio omitted`,
  withMedia
    ? `${LRM}[1/2/26, 9:08:00${NNBSP}AM] Ana Lima: ${LRM}<attached: 00000007-VIDEO-2026-01-02-09-08-00.mp4>`
    : `${LRM}[1/2/26, 9:08:00${NNBSP}AM] Ana Lima: ${LRM}video omitted`,
  `[1/2/26, 9:09:00${NNBSP}AM] Bo Chen: ${LRM}This message was deleted.`,
  `[1/2/26, 12:00:00${NNBSP}PM] Ana Lima: Lunch`,
  `[1/14/26, 11:59:59${NNBSP}PM] Bo Chen: Late night on the 14th`,
].join('\n') + '\n';

const IOS_US_MEDIA = [
  '00000005-PHOTO-2026-01-02-09-06-00.jpg',
  '00000006-AUDIO-2026-01-02-09-07-00.opus',
  '00000007-VIDEO-2026-01-02-09-08-00.mp4',
];

const IOS_US_WITH_MEDIA = { zip: 'WhatsApp Chat - iOS US.zip', media: IOS_US_MEDIA, txt: IOS_US_LINES(true) };
const IOS_US_WITHOUT_MEDIA = { zip: 'WhatsApp Chat - iOS US sin media.zip', media: [], txt: IOS_US_LINES(false) };

/** Android, Spanish: D/M/YY, 12h `a. m.` / `p. m.` (one with a no-break space). */
const ANDROID_ES = {
  zip: 'WhatsApp Chat - Android ES.zip',
  transcript: 'Chat de WhatsApp con Android ES.txt', // Android names the transcript, never `_chat.txt`
  media: ['IMG-20260101-WA0010.jpg'],
  txt: [
    '31/12/25, 11:58 p. m. - Los mensajes y las llamadas están cifrados de extremo a extremo. Nadie fuera de este chat, ni siquiera WhatsApp, puede leerlos ni escucharlos.',
    '31/12/25, 11:59 p. m. - Ana creó el grupo "Familia"',
    '1/1/26, 12:00 a. m. - Ana: ¡Feliz año!',
    `1/1/26, 12:05 a.${NBSP}m. - Bo: <Multimedia omitido>`,
    '1/1/26, 9:41 a. m. - Ana: IMG-20260101-WA0010.jpg (archivo adjunto)',
    'Mira esto',
    '1/1/26, 9:44 a. m. - Ana: Se eliminó este mensaje.',
    '1/1/26, 9:45 a. m. - Bo: Eliminaste este mensaje.',
    '13/1/26, 1:15 p. m. - Bo: Trece de enero',
  ].join('\n') + '\n',
};

/** iOS, Spanish: `[D/M/YY, H:mm:ss]` 24h, `<adjunto: …>`, `imagen omitida`. */
const IOS_ES = {
  zip: 'WhatsApp Chat - iOS ES.zip',
  media: ['00000001-PHOTO-2025-12-31-23-59-01.jpg'],
  txt: [
    `[31/12/25, 23:59:01] Ana: ${LRM}<adjunto: 00000001-PHOTO-2025-12-31-23-59-01.jpg>`,
    `[1/1/26, 0:00:10] Bo: ${LRM}imagen omitida`,
    `[1/1/26, 0:01:00] Bo: ${LRM}Se eliminó este mensaje.`,
    '[1/1/26, 0:02:00] Ana: Hola',
  ].join('\n') + '\n',
};

/** Android, Brazilian Portuguese: DD/MM/YYYY 24h without a comma. */
const ANDROID_PT = {
  zip: 'WhatsApp Chat - Android PT.zip',
  transcript: 'Conversa do WhatsApp com Android PT.txt',
  media: ['IMG-20260101-WA0020.jpg'],
  txt: [
    '31/12/2025 23:58 - Ana: Feliz ano novo!',
    '31/12/2025 23:59 - Bo: <Mídia oculta>',
    '01/01/2026 00:01 - Ana: IMG-20260101-WA0020.jpg (arquivo anexado)',
    '01/01/2026 00:02 - Ana: Mensagem apagada',
    '01/01/2026 00:03 - Bo: Você apagou esta mensagem',
    '01/01/2026 00:04 - Bo: [anexado] não é um anexo de verdade',
  ].join('\n') + '\n',
};

/** Android, Catalan: D/M/YY 24h. Best-effort strings (no ca export at hand). */
const ANDROID_CA = {
  zip: 'WhatsApp Chat - Android CA.zip',
  transcript: 'Xat de WhatsApp amb Android CA.txt',
  media: ['IMG-20260101-WA0030.jpg'],
  txt: [
    '31/12/25 23:58 - Ana: Bon any!',
    '31/12/25 23:59 - Bo: <Multimèdia omès>',
    '1/1/26 0:01 - Ana: IMG-20260101-WA0030.jpg (fitxer adjunt)',
    "1/1/26 0:02 - Ana: S'ha suprimit aquest missatge.",
    '1/1/26 0:03 - Bo: Has suprimit aquest missatge.',
  ].join('\n') + '\n',
};

export const FORMAT_FIXTURES = [
  ANDROID_US,
  IOS_US_WITH_MEDIA,
  IOS_US_WITHOUT_MEDIA,
  ANDROID_ES,
  IOS_ES,
  ANDROID_PT,
  ANDROID_CA,
];

/** Root-level ZIP, like a real phone export. */
function buildRootZip({ zip, txt, media, transcript }) {
  const files = { [transcript ?? '_chat.txt']: Buffer.from(txt, 'utf8') };
  for (const name of media) files[name] = PLACEHOLDER;
  fs.writeFileSync(path.join(FIXTURES, zip), Buffer.from(zipSync(files)));
}

function writeChat(chat, txt, media) {
  const dir = path.join(FIXTURES, chat);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '_chat.txt'), txt, 'utf8');
  for (const name of media) {
    fs.writeFileSync(path.join(dir, name), PLACEHOLDER);
  }
  return dir;
}

function buildZip(chat, txt, media) {
  const files = { [`${chat}/_chat.txt`]: Buffer.from(txt, 'utf8') };
  for (const name of media) {
    files[`${chat}/${name}`] = PLACEHOLDER;
  }
  const zipPath = path.join(FIXTURES, `${chat}.zip`);
  fs.writeFileSync(zipPath, Buffer.from(zipSync(files)));
}

function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  writeChat(NOTAS, NOTAS_TXT, NOTAS_MEDIA);
  writeChat(ORG, ORG_TXT, ORG_MEDIA);
  // html-media/theme/media tests read the pre-built Notas zip.
  buildZip(NOTAS, NOTAS_TXT, NOTAS_MEDIA);
  for (const f of FORMAT_FIXTURES) buildRootZip(f);
  // Catalan demo set for the README screenshots (`pnpm screenshots`): fixtures/showcase/.
  writeShowcase(FIXTURES);
  // Synthetic Google Photos Takeout albums (lib/importers/takeout, lib/usecases/takeout-import).
  writeTakeoutFixtures(FIXTURES);
  console.log('[generate-fixtures] wrote synthetic fixtures to', FIXTURES);
}

// Run only as a script, so tests can import FORMAT_FIXTURES without side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
