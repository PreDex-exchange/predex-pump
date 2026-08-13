import { describe, expect, it } from 'vitest';

import { isConnectedWalletMaker } from './order-ownership';

describe('isConnectedWalletMaker', () => {
  it('matches addresses case-insensitively and requires a connected wallet', () => {
    expect(
      isConnectedWalletMaker(
        '0xAbCdEf0000000000000000000000000000000000',
        '0xabcdef0000000000000000000000000000000000',
      ),
    ).toBe(true);
    expect(
      isConnectedWalletMaker(
        '0xAbCdEf0000000000000000000000000000000000',
        undefined,
      ),
    ).toBe(false);
  });
});
