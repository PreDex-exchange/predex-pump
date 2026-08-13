import type { Trade } from '@predex-pump/shared/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RecentTrades } from './RecentTrades';

afterEach(cleanup);

describe('RecentTrades money precision', () => {
  it('shows the raw execution price at the same precision as the order books', () => {
    const trade: Trade = {
      id: `0x${'ab'.repeat(32)}:1`,
      marketId: '15',
      venue: 'LMSR',
      account: `0x${'12'.repeat(20)}`,
      outcome: 'YES',
      side: 'BID',
      sizeRaw: '100000',
      priceRaw: '522684',
      costRaw: '52268',
      feeRaw: '0',
      txHash: `0x${'ab'.repeat(32)}`,
      logIndex: 1,
      ts: 1_900_000_000,
    };

    render(<RecentTrades trades={[trade]} />);

    expect(screen.getByText('0.522684')).toBeTruthy();
    expect(screen.queryByText('0.52')).toBeNull();
  });
});
