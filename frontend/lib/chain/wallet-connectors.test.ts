import { describe, expect, it } from 'vitest';

import { hasPredexQaProvider } from './wallet-connectors';

describe('wallet connector selection', () => {
  it('recognizes only the isolated Predex QA provider', () => {
    expect(hasPredexQaProvider(undefined)).toBe(false);
    expect(
      hasPredexQaProvider({ ethereum: {} } as unknown as Window),
    ).toBe(false);
    expect(
      hasPredexQaProvider({
        ethereum: { isPredexQaWallet: true },
      } as unknown as Window),
    ).toBe(true);
  });
});
