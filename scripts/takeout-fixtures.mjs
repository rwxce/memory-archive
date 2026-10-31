// Synthetic Google Photos Takeout fixtures. Invented file names, invented places, fake bytes
// ("pictures" are short deterministic byte strings; nothing is decoded). Nothing here comes
// from a real Google export. Deterministic: no clock, no randomness.
//
// `takeoutAlbumFiles()` returns the entries of a Takeout ZIP as `{ path: Uint8Array }`; tests
// zip them (and mutate them to build hostile variants). `writeTakeoutFixtures(dir)` writes the
// ZIP to fixtures/takeout-albums.zip for the smoke run. Called from generate-fixtures.mjs.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';

const enc = (text) => strToU8(text);

/** A fake picture: distinct bytes per seed, so every seed hashes differently. */
export const fakeBytes = (seed, kind = 'jpg') => enc(`FAKE-${kind.toUpperCase()}-${seed}-`.repeat(8));

const GEO_NONE = { latitude: 0, longitude: 0, altitude: 0, latitudeSpan: 0, longitudeSpan: 0 };

/** UTC instants of the fixture pictures (epoch seconds as strings, like Google writes them). */
export const TAKEN = {
  lisbon1: { timestamp: '1561975200', iso: '2019-07-01T10:00:00Z' },
  lisbon2: { timestamp: '1562061600', iso: '2019-07-02T10:00:00Z' },
  lisbon3: { timestamp: '1562148000', iso: '2019-07-03T10:00:00Z' },
  lisbon4: { timestamp: '1562234400', iso: '2019-07-04T10:00:00Z' },
  lisbon5: { timestamp: '1562320800', iso: '2019-07-05T10:00:00Z' },
  lisbon6: { timestamp: '1562407200', iso: '2019-07-06T10:00:00Z' },
  lisbon7: { timestamp: '1562493600', iso: '2019-07-07T10:00:00Z' },
  lisbon10: { timestamp: '1562580000', iso: '2019-07-08T10:00:00Z' },
};

function sidecar(title, taken, extra = {}) {
  return enc(
    JSON.stringify({
      title,
      description: '',
      imageViews: '3',
      creationTime: { timestamp: '1700000000', formatted: 'uploaded later' },
      photoTakenTime: { timestamp: taken.timestamp, formatted: 'whenever' },
      geoData: GEO_NONE,
      geoDataExif: GEO_NONE,
      people: [{ name: 'Invented Person' }],
      url: 'https://photos.invalid/photo/x',
      favorited: true,
      ...extra,
    }),
  );
}

const LISBON = 'Takeout/Google Photos/Trip to Lisbon/';
const FAMILY = 'Takeout/Google Photos/Family dinner/';

/** The long name whose sidecar name is cut to 46 characters. */
export const LONG_NAME = 'PXL_20190704_101500123.RAW-01.MP.COVER_long_name_for_truncation.jpg';
/** Its sidecar: `<name>.supplemental-metadata` cut at 46 characters, then `.json`. */
export const LONG_SIDECAR = `${(LONG_NAME + '.supplemental-metadata').slice(0, 46)}.json`;

export function takeoutAlbumFiles() {
  const f = {};
  f['Takeout/archive_browser.html'] = enc('<html></html>');
  f[`${LISBON}metadata.json`] = enc(JSON.stringify({ title: 'Trip to Lisbon', description: '', access: 'protected', date: { timestamp: '1561939200' } }));

  // 1. classic sidecar, with a location and a description
  f[`${LISBON}IMG_0001.jpg`] = fakeBytes(1);
  f[`${LISBON}IMG_0001.jpg.json`] = sidecar('IMG_0001.jpg', TAKEN.lisbon1, {
    description: 'Sunset at the viewpoint',
    geoData: { latitude: 38.7139, longitude: -9.1334, altitude: 20, latitudeSpan: 0, longitudeSpan: 0 },
  });
  // 2. new-style sidecar name
  f[`${LISBON}IMG_0002.jpg`] = fakeBytes(2);
  f[`${LISBON}IMG_0002.jpg.supplemental-metadata.json`] = sidecar('IMG_0002.jpg', TAKEN.lisbon2, {
    geoData: GEO_NONE,
    geoDataExif: { latitude: 38.7, longitude: -9.2, altitude: 0, latitudeSpan: 0, longitudeSpan: 0 },
  });
  // 3. long picture name: the sidecar name is cut
  f[`${LISBON}${LONG_NAME}`] = fakeBytes(3);
  f[`${LISBON}${LONG_SIDECAR}`] = sidecar(LONG_NAME, TAKEN.lisbon3);
  // 4. suffix cut inside ".supplemental-metadata"
  f[`${LISBON}IMG_0004.jpg`] = fakeBytes(4);
  f[`${LISBON}IMG_0004.jpg.supplemental-meta.json`] = sidecar('IMG_0004.jpg', TAKEN.lisbon4);
  // 5. duplicate names: IMG_0005.jpg and IMG_0005(1).jpg, whose sidecar is IMG_0005.jpg(1).json
  f[`${LISBON}IMG_0005.jpg`] = fakeBytes(5);
  f[`${LISBON}IMG_0005.jpg.json`] = sidecar('IMG_0005.jpg', TAKEN.lisbon5);
  f[`${LISBON}IMG_0005(1).jpg`] = fakeBytes(55);
  f[`${LISBON}IMG_0005.jpg(1).json`] = sidecar('IMG_0005.jpg', TAKEN.lisbon6);
  // 6. an edited copy has no sidecar of its own
  f[`${LISBON}IMG_0006.jpg`] = fakeBytes(6);
  f[`${LISBON}IMG_0006.jpg.json`] = sidecar('IMG_0006.jpg', TAKEN.lisbon6);
  f[`${LISBON}IMG_0006-edited.jpg`] = fakeBytes(66);
  // 7. a video
  f[`${LISBON}VID_0007.mp4`] = fakeBytes(7, 'mp4');
  f[`${LISBON}VID_0007.mp4.supplemental-metadata.json`] = sidecar('VID_0007.mp4', TAKEN.lisbon7);
  // 8. no sidecar at all
  f[`${LISBON}IMG_0008.jpg`] = fakeBytes(8);
  // 9. a hostile sidecar: wrong types, out-of-range values, a path-like title, control characters
  f[`${LISBON}IMG_0009.jpg`] = fakeBytes(9);
  f[`${LISBON}IMG_0009.jpg.json`] = enc(
    JSON.stringify({
      title: '../../etc/passwd',
      description: 'line one\u0000\u001b[31mred\nline two',
      photoTakenTime: { timestamp: 'not a number' },
      geoData: { latitude: 999, longitude: 'far away' },
      geoDataExif: { latitude: -91, longitude: 0 },
      people: 'everyone',
    }).replace(/}$/, ',"__proto__":{"polluted":true}}'),
  );
  // 10. a live photo: the still has a sidecar, its video does not
  f[`${LISBON}IMG_0010.jpg`] = fakeBytes(10);
  f[`${LISBON}IMG_0010.jpg.json`] = sidecar('IMG_0010.jpg', TAKEN.lisbon10);
  f[`${LISBON}IMG_0010.MP4`] = fakeBytes(1010, 'mp4');
  // 11. things that are not pictures
  f[`${LISBON}notes.txt`] = enc('not a picture');
  f[`${LISBON}IMG_0011.xyz`] = fakeBytes(11);

  // A second album: the very same picture as IMG_0001 (same bytes, other name), and one new one.
  f[`${FAMILY}metadata.json`] = enc(JSON.stringify({ title: 'Family dinner', description: '' }));
  f[`${FAMILY}dinner-1.jpg`] = fakeBytes(1);
  f[`${FAMILY}dinner-1.jpg.json`] = sidecar('dinner-1.jpg', TAKEN.lisbon1);
  f[`${FAMILY}dinner-2.jpg`] = fakeBytes(12);
  f[`${FAMILY}dinner-2.jpg.json`] = sidecar('dinner-2.jpg', TAKEN.lisbon2);
  return f;
}

/** The same entries as a ZIP (stored, no compression: the bytes are fake). */
export function takeoutZip(files = takeoutAlbumFiles()) {
  return zipSync(files, { level: 0 });
}

export function writeTakeoutFixtures(fixturesDir) {
  fs.writeFileSync(path.join(fixturesDir, 'takeout-albums.zip'), takeoutZip());
}
