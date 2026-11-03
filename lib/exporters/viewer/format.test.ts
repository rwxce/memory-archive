import { describe, expect, test } from 'vitest';
import { GENERATOR_NAME, GENERATOR_VERSION } from '../legacy/version';
import { buildViewerData } from './build';
import { parseViewerData, serializeViewerData, VIEWER_SCHEMA_VERSION, ViewerDataError, viewerMediaPath, type ViewerData } from './format';

const HASH = 'ab'.repeat(32);

const sample = (): ViewerData =>
  buildViewerData({
    now: '2026-03-01T10:00:00.000Z',
    from: null,
    to: null,
    includeMedia: true,
    profiles: [{ id: 'p1', displayName: 'Ana', relationship: '', description: '' }],
    conversations: [
      {
        id: 'c1',
        title: '</script><img src=x onerror=alert(1)>',
        source: 'whatsapp',
        isGroup: false,
        profileIds: ['p1'],
        participants: [{ displayName: '<b>Ana</b>', isMe: false }],
        messages: [
          {
            sentAt: '2026-01-01T10:00:00',
            type: 'photo',
            participantName: '<b>Ana</b>',
            isMe: false,
            body: 'hi <!-- & \u2028 x',
            mediaSha256: HASH,
            mediaName: '../../etc/passwd.JPG',
            mediaMime: 'image/jpeg',
          },
        ],
      },
    ],
    availableMedia: new Map([[HASH, 3]]),
  });

const rejection = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('viewer data format', () => {
  test('envelope carries format, schema version and generator', () => {
    expect(sample()).toMatchObject({
      format: 'memory-archive-viewer',
      schemaVersion: VIEWER_SCHEMA_VERSION,
      generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    });
  });

  test('untrusted strings stay plain data and round-trip; the island text cannot close a script tag', () => {
    const data = sample();
    const text = serializeViewerData(data);
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(parseViewerData(text)).toEqual(data);
    expect(data.conversations[0].title).toBe('</script><img src=x onerror=alert(1)>');
    expect(data.conversations[0].messages[0].author).toBe('<b>Ana</b>');
  });

  test('a hostile file name cannot shape the media path', () => {
    expect(sample().media[0].path).toBe(`media/${HASH}.jpg`);
    expect(viewerMediaPath(HASH, { name: 'x.j/../p', mime: null })).toBe(`media/${HASH}.bin`);
    expect(viewerMediaPath(HASH, { name: 'noext', mime: 'audio/ogg' })).toBe(`media/${HASH}.ogg`);
    expect(viewerMediaPath(HASH, { name: 'a.verylongextension' })).toBe(`media/${HASH}.bin`);
  });

  test('a newer schemaVersion is refused with its own code', () => {
    const newer = JSON.stringify({ ...sample(), schemaVersion: VIEWER_SCHEMA_VERSION + 1 });
    expect(rejection(() => parseViewerData(newer))).toMatchObject({ code: 'newer-schema' });
  });

  test.each([
    ['not json', 'nope'],
    ['other format', JSON.stringify({ format: 'x' })],
    ['bad version', JSON.stringify({ ...sample(), schemaVersion: 0 })],
    ['missing section', JSON.stringify({ ...sample(), media: undefined })],
    ['media path outside media/', JSON.stringify({ ...sample(), media: [{ path: '../x' }] })],
  ])('refuses invalid data: %s', (_name, text) => {
    const error = rejection(() => parseViewerData(text));
    expect(error).toBeInstanceOf(ViewerDataError);
    expect(error).toMatchObject({ code: 'invalid' });
  });
});
