/**
 * Detection + classification across export styles and locales, on the
 * synthetic fixtures from `scripts/generate-fixtures.mjs` (FORMAT_FIXTURES).
 * Each fixture is parsed from a Blob, exactly as the browser will do it.
 */
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWhatsAppZip } from './import';
import type { MessageType } from './types';

type Row = [timestamp: string, type: MessageType, author: string, text: string, media?: string];

async function parseFixture(zipName: string) {
  const bytes = fs.readFileSync(path.join(process.cwd(), 'fixtures', zipName));
  return parseWhatsAppZip(new Blob([bytes]), zipName);
}

function rows(messages: Array<{ timestamp_iso: string; type: MessageType; author: string; text: string; media: string }>): Row[] {
  return messages.map((m) => {
    const r: Row = [m.timestamp_iso, m.type, m.author, m.text];
    if (m.media) r.push(m.media);
    return r;
  });
}

const IOS_US_COMMON_HEAD: Row[] = [
  ['2026-01-02T09:00:00', 'system', 'Family 2026', 'Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.'],
  ['2026-01-02T09:00:01', 'system', 'Family 2026', 'Ana Lima created this group'],
  ['2026-01-02T09:05:01', 'text', 'Ana Lima', 'Good morning'],
  ['2026-01-02T09:05:30', 'text', 'Bo Chen', 'Morning!\nCoffee?'],
];
const IOS_US_COMMON_TAIL: Row[] = [
  ['2026-01-02T09:09:00', 'deleted', 'Bo Chen', 'This message was deleted.'],
  ['2026-01-02T12:00:00', 'text', 'Ana Lima', 'Lunch'],
  ['2026-01-14T23:59:59', 'text', 'Bo Chen', 'Late night on the 14th'],
];

const CASES: Array<{
  zip: string;
  name: string;
  dayFirst: boolean;
  is12h: boolean;
  rows: Row[];
}> = [
  {
    zip: 'WhatsApp Chat - Android US.zip',
    name: 'Android US',
    dayFirst: false,
    is12h: true,
    rows: [
      ['2025-12-31T23:58:00', 'system', '', 'Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them. Tap to learn more.'],
      ['2025-12-31T23:59:00', 'system', '', 'Ana Lima created group "Family 2026"'],
      ['2025-12-31T23:59:00', 'system', '', 'Ana Lima added Bo Chen'],
      ['2026-01-01T00:00:00', 'text', 'Ana Lima', 'Happy new year!'],
      ['2026-01-01T00:01:00', 'text', 'Bo Chen', 'Thanks!\nThis is a second line\n\nand a third one after a blank line'],
      ['2026-01-01T00:05:00', 'omitted', 'Bo Chen', '<Media omitted>'],
      ['2026-01-01T09:41:00', 'photo', 'Ana Lima', '', 'IMG-20260101-WA0001.jpg'],
      ['2026-01-01T09:41:00', 'video', 'Ana Lima', 'Look at this', 'VID-20260101-WA0002.mp4'],
      ['2026-01-01T09:42:00', 'audio', 'Bo Chen', '', 'PTT-20260101-WA0003.opus'],
      ['2026-01-01T09:43:00', 'sticker', 'Bo Chen', '', 'STK-20260101-WA0004.webp'],
      ['2026-01-01T09:44:00', 'deleted', 'Ana Lima', 'This message was deleted'],
      ['2026-01-01T09:45:00', 'deleted', 'Bo Chen', 'You deleted this message'],
      ['2026-01-01T12:30:00', 'text', 'Ana Lima', 'ok'],
      ['2026-01-01T12:30:00', 'text', 'Ana Lima', 'ok'],
      ['2026-01-13T13:15:00', 'text', 'Bo Chen', 'The 13th makes the month-first order unambiguous'],
    ],
  },
  {
    zip: 'WhatsApp Chat - iOS US.zip',
    name: 'iOS US',
    dayFirst: false,
    is12h: true,
    rows: [
      ...IOS_US_COMMON_HEAD,
      ['2026-01-02T09:06:00', 'photo', 'Bo Chen', '', '00000005-PHOTO-2026-01-02-09-06-00.jpg'],
      ['2026-01-02T09:07:00', 'audio', 'Ana Lima', '', '00000006-AUDIO-2026-01-02-09-07-00.opus'],
      ['2026-01-02T09:08:00', 'video', 'Ana Lima', '', '00000007-VIDEO-2026-01-02-09-08-00.mp4'],
      ...IOS_US_COMMON_TAIL,
    ],
  },
  {
    zip: 'WhatsApp Chat - iOS US sin media.zip',
    name: 'iOS US sin media',
    dayFirst: false,
    is12h: true,
    rows: [
      ...IOS_US_COMMON_HEAD,
      ['2026-01-02T09:06:00', 'omitted', 'Bo Chen', 'image omitted'],
      ['2026-01-02T09:07:00', 'omitted', 'Ana Lima', 'audio omitted'],
      ['2026-01-02T09:08:00', 'omitted', 'Ana Lima', 'video omitted'],
      ...IOS_US_COMMON_TAIL,
    ],
  },
  {
    zip: 'WhatsApp Chat - Android ES.zip',
    name: 'Android ES',
    dayFirst: true,
    is12h: true,
    rows: [
      ['2025-12-31T23:58:00', 'system', '', 'Los mensajes y las llamadas están cifrados de extremo a extremo. Nadie fuera de este chat, ni siquiera WhatsApp, puede leerlos ni escucharlos.'],
      ['2025-12-31T23:59:00', 'system', '', 'Ana creó el grupo "Familia"'],
      ['2026-01-01T00:00:00', 'text', 'Ana', '¡Feliz año!'],
      ['2026-01-01T00:05:00', 'omitted', 'Bo', '<Multimedia omitido>'],
      ['2026-01-01T09:41:00', 'photo', 'Ana', 'Mira esto', 'IMG-20260101-WA0010.jpg'],
      ['2026-01-01T09:44:00', 'deleted', 'Ana', 'Se eliminó este mensaje.'],
      ['2026-01-01T09:45:00', 'deleted', 'Bo', 'Eliminaste este mensaje.'],
      ['2026-01-13T13:15:00', 'text', 'Bo', 'Trece de enero'],
    ],
  },
  {
    zip: 'WhatsApp Chat - iOS ES.zip',
    name: 'iOS ES',
    dayFirst: true,
    is12h: false,
    rows: [
      ['2025-12-31T23:59:01', 'photo', 'Ana', '', '00000001-PHOTO-2025-12-31-23-59-01.jpg'],
      ['2026-01-01T00:00:10', 'omitted', 'Bo', 'imagen omitida'],
      ['2026-01-01T00:01:00', 'deleted', 'Bo', 'Se eliminó este mensaje.'],
      ['2026-01-01T00:02:00', 'text', 'Ana', 'Hola'],
    ],
  },
  {
    zip: 'WhatsApp Chat - Android PT.zip',
    name: 'Android PT',
    dayFirst: true,
    is12h: false,
    rows: [
      ['2025-12-31T23:58:00', 'text', 'Ana', 'Feliz ano novo!'],
      ['2025-12-31T23:59:00', 'omitted', 'Bo', '<Mídia oculta>'],
      ['2026-01-01T00:01:00', 'photo', 'Ana', '', 'IMG-20260101-WA0020.jpg'],
      ['2026-01-01T00:02:00', 'deleted', 'Ana', 'Mensagem apagada'],
      ['2026-01-01T00:03:00', 'deleted', 'Bo', 'Você apagou esta mensagem'],
      ['2026-01-01T00:04:00', 'text', 'Bo', '[anexado] não é um anexo de verdade'],
    ],
  },
  {
    zip: 'WhatsApp Chat - Android CA.zip',
    name: 'Android CA',
    dayFirst: true,
    is12h: false,
    rows: [
      ['2025-12-31T23:58:00', 'text', 'Ana', 'Bon any!'],
      ['2025-12-31T23:59:00', 'omitted', 'Bo', '<Multimèdia omès>'],
      ['2026-01-01T00:01:00', 'photo', 'Ana', '', 'IMG-20260101-WA0030.jpg'],
      ['2026-01-01T00:02:00', 'deleted', 'Ana', "S'ha suprimit aquest missatge."],
      ['2026-01-01T00:03:00', 'deleted', 'Bo', 'Has suprimit aquest missatge.'],
    ],
  },
];

describe.each(CASES)('$name export', ({ zip, name, dayFirst, is12h, rows: expected }) => {
  test('detects the date order and clock', async () => {
    const { detection, info } = await parseFixture(zip);
    expect(info.name).toBe(name);
    expect(detection).toMatchObject({ dayFirst, is12h, overridden: false });
  });

  test('parses and classifies every message', async () => {
    const { messages, warnings } = await parseFixture(zip);
    expect(rows(messages)).toEqual(expected);
    expect(warnings).toEqual([]);
  });

  test('every referenced media file is in the archive (or none is, without media)', async () => {
    const { messages, entries } = await parseFixture(zip);
    const names = new Set(entries.map((e) => e.name));
    for (const m of messages) if (m.media) expect(names.has(m.media), m.media).toBe(true);
  });
});
