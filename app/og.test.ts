import { describe, expect, it } from 'vitest';
import { ogImage, shareMetadata } from './og';

describe('ogImage', () => {
  it('points at the locale card', () => {
    expect(ogImage('ca', 'x')).toMatchObject({ url: expect.stringMatching(/\/og\/ca\.png\?v=\d+$/), width: 1200, height: 630 });
  });

  it('falls back to the default card for an unknown locale', () => {
    expect(ogImage('xx', 'x').url).toMatch(/\/og\/en\.png/);
  });
});

describe('shareMetadata', () => {
  it('sets a large card and the Open Graph locale', () => {
    const meta = shareMetadata({ locale: 'es', title: 'T', description: 'D', path: '/es/' });
    expect(meta.metadataBase).toBeInstanceOf(URL);
    expect(meta.openGraph).toMatchObject({ locale: 'es_ES', title: 'T', description: 'D' });
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image' });
  });
});
