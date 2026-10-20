import type { MetadataRoute } from 'next';

// Exported as out/manifest.webmanifest (linked from every page by Next.js).
export const dynamic = 'force-static';

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: `${base}/`,
    name: 'Memory Archive',
    short_name: 'Memories',
    description:
      'Keep the conversations, photos and voice messages of the people who matter to you. Everything stays on this device.',
    start_url: `${base}/`,
    scope: `${base}/`,
    display: 'standalone',
    orientation: 'any',
    background_color: '#fbf8f3',
    theme_color: '#7f4e38',
    categories: ['lifestyle', 'utilities'],
    icons: [
      { src: `${base}/icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}/icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}/icons/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // Android: "Share" a WhatsApp export (ZIP or TXT) straight to the app.
    // Handled by the service worker (sw/share-target.ts).
    share_target: {
      action: `${base}/share-target/`,
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title',
        text: 'text',
        url: 'url',
        files: [
          {
            name: 'files',
            accept: ['application/zip', 'application/x-zip-compressed', 'text/plain', '.zip', '.txt'],
          },
        ],
      },
    },
  };
}
