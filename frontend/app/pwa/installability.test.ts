// @vitest-environment node

import { describe, expect, it } from 'vitest';

import manifest from '../manifest';
import { GET as getIcon192 } from './icon-192.png/route';
import { GET as getIcon512 } from './icon-512.png/route';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

describe('PWA installability metadata', () => {
  it('publishes a standalone root-scoped manifest with mask-safe icons', () => {
    const value = manifest();

    expect(value).toMatchObject({
      background_color: '#fff7ee',
      display: 'standalone',
      name: 'predex — Prediction Market Incubator',
      scope: '/',
      short_name: 'predex',
      start_url: '/',
      theme_color: '#fff7ee',
    });
    expect(value.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sizes: '192x192',
          src: '/pwa/icon-192.png',
          type: 'image/png',
        }),
        expect.objectContaining({
          purpose: 'maskable',
          sizes: '512x512',
          src: '/pwa/icon-512.png',
          type: 'image/png',
        }),
      ]),
    );
  });

  it.each([
    [192, getIcon192],
    [512, getIcon512],
  ] as const)('serves a real %i pixel square PNG', async (size, getIcon) => {
    const response = getIcon();
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    expect(response.headers.get('content-type')).toBe('image/png');
    expect([...bytes.slice(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
    expect(view.getUint32(16)).toBe(size);
    expect(view.getUint32(20)).toBe(size);
  });
});
