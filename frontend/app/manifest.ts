import type { MetadataRoute } from 'next';

import { PWA_COLORS } from '@/lib/pwa/palette';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'predex — Prediction Market Incubator',
    short_name: 'predex',
    description:
      'Launch prediction markets, trade them on Arc, and follow their path from bonding curve to order book.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: PWA_COLORS.background,
    theme_color: PWA_COLORS.background,
    categories: ['finance', 'social'],
    lang: 'en',
    icons: [
      {
        src: '/pwa/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/pwa/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/pwa/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
