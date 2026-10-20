// Generates synthetic, non-personal WhatsApp export fixtures into ./fixtures
// so the test-suite can run in CI without the developer's real (gitignored)
// `data/` folder. The content reproduces the demo strings the assertions pin
// but contains no personal conversations.
//
// Run automatically via the `pretest` npm script before `npm test`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { zipSync } from 'fflate';

const ROOT = process.cwd();
const FIXTURES = path.join(ROOT, 'fixtures');

const NOTAS = 'WhatsApp Chat - Notas pessoais';
const WK = 'WhatsApp Chat - Plataforma WK';

// 17 media files referenced by the reconcileMedia test (basenames only).
const NOTAS_MEDIA = [
  '00000008-STICKER-2026-04-03-15-17-12.webp',
  '00000021-STICKER-2026-04-10-21-58-01.webp',
  '00000023-STICKER-2026-04-11-13-24-21.webp',
  '00000040-STICKER-2026-04-20-15-16-33.webp',
  '00000045-STICKER-2026-04-23-23-19-31.webp',
  '00000068-Conversa do WhatsApp com Notas pessoais.zip',
  '00000088-STICKER-2026-05-27-08-45-13.webp',
  '00000089-VIDEO-2026-05-27-17-26-38.mp4',
  '00000091-PHOTO-2026-05-29-17-23-37.jpg',
  '00000098-PHOTO-2026-06-10-13-55-47.jpg',
  '00000099-STICKER-2026-06-10-13-55-59.webp',
  '00000134-PHOTO-2026-07-18-22-34-29.jpg',
  '00000147-PHOTO-2026-07-26-19-23-49.jpg',
  '00000148-PHOTO-2026-07-28-07-48-08.jpg',
  '00000149-PHOTO-2026-07-28-07-48-50.jpg',
  '00000152-96980389904-IRPF-D-0-0211-31-07-2026-08-03.pdf',
  '00000153-raw.pdf',
];

const WK_MEDIA = [
  '00003010-STICKER-2026-07-23-12-41-49.webp',
  '00003036-PHOTO-2026-07-23-23-31-30.jpg',
  '00003046-PHOTO-2026-07-24-10-41-01.jpg',
  '00003046-PHOTO-2026-07-24-10-41-02.jpg',
  '00003046-PHOTO-2026-07-24-10-41-03.jpg',
  '00003046-PHOTO-2026-07-24-10-41-04.jpg',
  '00003046-PHOTO-2026-07-24-10-41-05.jpg',
];

// Tiny placeholder bytes so the files exist for media reconciliation.
const PLACEHOLDER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// iOS-bracketed format: [DD/MM/YYYY HH:MM:SS] Sender: body
const NOTAS_TXT = [
  '[17/03/2026 13:17:59] Guionardo Furlan: https://lefthook.dev/',
  '[20/03/2026 16:20:22] Guionardo Furlan: image omitted',
  '[25/03/2026 19:52:16] Guionardo Furlan: Mensagem apagada',
  '[25/03/2026 19:52:29] Guionardo Furlan: sticker omitted',
  '[28/03/2026 07:15:45] Guionardo Furlan: autorizacao_atividade.pdf document omitted',
  '[03/04/2026 15:17:12] Guionardo Furlan: <attached: 00000008-STICKER-2026-04-03-15-17-12.webp>',
  '[29/05/2026 17:23:37] Guionardo Furlan: Taxa João Furlan <attached: 00000091-PHOTO-2026-05-29-17-23-37.jpg>',
  '[30/07/2026 21:44:36] Guionardo Furlan: <attached: 00000152-96980389904-IRPF-D-0-0211-31-07-2026-08-03.pdf> 96980389904-IRPF-D-0-0211-31-07-2026-08-03.pdf • ‎1 página',
  // 4 empty-body + same-author attachment pairs (merge into one media row each)
  // to balance the dedupe assertion (excluded omitted/deleted == merges).
  '[10/04/2026 10:00:00] Guionardo Furlan:',
  '[10/04/2026 10:00:01] Guionardo Furlan: <attached: 00000021-STICKER-2026-04-10-21-58-01.webp>',
  '[11/04/2026 10:00:00] Guionardo Furlan:',
  '[11/04/2026 10:00:01] Guionardo Furlan: <attached: 00000023-STICKER-2026-04-11-13-24-21.webp>',
  '[20/04/2026 10:00:00] Guionardo Furlan:',
  '[20/04/2026 10:00:01] Guionardo Furlan: <attached: 00000040-STICKER-2026-04-20-15-16-33.webp>',
  '[23/04/2026 10:00:00] Guionardo Furlan:',
  '[23/04/2026 10:00:01] Guionardo Furlan: <attached: 00000045-STICKER-2026-04-23-23-19-31.webp>',
].join('\n') + '\n';

const WK_TXT = [
  '[23/07/2026 09:47:18] Plataforma WK: Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.',
  '[23/07/2026 12:15:28] +55 99 99951-1234: Olá equipe',
  '[23/07/2026 12:41:48] Guionardo Furlan: <attached: 00003010-STICKER-2026-07-23-12-41-49.webp>',
  '[23/07/2026 23:31:29] Camilla Araujo WK:',
  '[23/07/2026 23:31:30] Camilla Araujo WK: <attached: 00003036-PHOTO-2026-07-23-23-31-30.jpg>',
  '[23/07/2026 12:42:00] Guionardo Furlan: Rede: Conexão WK - Staff',
  'Senha: TIMEWK2026',
  '[23/07/2026 18:00:00] Guionardo Furlan: Mensagem apagada',
  '[23/07/2026 12:50:00] Guionardo Furlan: sticker omitted',
  '[24/07/2026 10:41:01] Gian Carlo: <attached: 00003046-PHOTO-2026-07-24-10-41-01.jpg>',
  '[24/07/2026 10:41:02] Gian Carlo: <attached: 00003046-PHOTO-2026-07-24-10-41-02.jpg>',
  '[24/07/2026 10:41:03] Gian Carlo: <attached: 00003046-PHOTO-2026-07-24-10-41-03.jpg>',
  '[24/07/2026 10:41:04] Gian Carlo: <attached: 00003046-PHOTO-2026-07-24-10-41-04.jpg>',
  '[24/07/2026 10:41:05] Gian Carlo: <attached: 00003046-PHOTO-2026-07-24-10-41-05.jpg>',
  // empty-body + same-author attachment pair (merges into one media row) to
  // balance the dedupe assertion (excluded omitted/deleted == merges).
  '[23/07/2026 19:00:00] Guionardo Furlan:',
  '[23/07/2026 19:00:01] Guionardo Furlan: <attached: 00003010-STICKER-2026-07-23-12-41-49.webp>',
  '[20/08/2026 10:00:00] Plataforma WK: última mensagem do período',
].join('\n') + '\n';

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
  writeChat(WK, WK_TXT, WK_MEDIA);
  // html-media/theme/media tests read the pre-built Notas zip.
  buildZip(NOTAS, NOTAS_TXT, NOTAS_MEDIA);
  console.log('[generate-fixtures] wrote synthetic fixtures to', FIXTURES);
}

main();
