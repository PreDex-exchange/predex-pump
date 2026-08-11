import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendRestClient } from './rest-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser fetch failure copy', () => {
  it.each([
    ['PATCH', () => backendRestClient.updateAccountProfile({ displayName: 'Ada' })],
    ['DELETE', () => backendRestClient.withdrawOrder(`0x${'1'.repeat(64)}`)],
  ])('does not report a failed %s method as an unreachable API', async (method, request) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(request()).rejects.toThrow(
      `The indexed API did not complete the ${method} request.`,
    );
    await expect(request()).rejects.not.toThrow('could not be reached');
  });
});
