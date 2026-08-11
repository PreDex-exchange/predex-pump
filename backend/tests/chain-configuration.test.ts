import { ARC } from '@predex-pump/shared';
import { describe, expect, it } from 'vitest';

import { ARC_CHAIN } from '../src/orderbook/chain-reader.js';

describe('Arc chain configuration', () => {
  it('exposes the canonical Multicall3 deployment to viem clients', () => {
    expect(ARC.contracts.multicall3.address).toBe(
      '0xcA11bde05977b3631167028862bE2a173976CA11',
    );
    expect(ARC_CHAIN.contracts?.multicall3?.address).toBe(
      ARC.contracts.multicall3.address,
    );
  });
});
