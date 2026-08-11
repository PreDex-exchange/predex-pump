import type {
  OffchainOrder,
  Order,
  OrderBook,
} from '@predex-pump/shared/domain';
import type { ExchangeApprovalStateResponse } from '@predex-pump/shared/rest';
import {
  buildCtfExchangeOrder,
  ctfExchangeOrderToWire,
  Side,
} from '@predex-pump/shared/tx';
import { describe, expect, it } from 'vitest';

import {
  buildHybridOrderCommitment,
  fillApprovalRequirement,
  makerApprovalRequirement,
  orderBookForVenue,
} from './hybrid';

const MAKER = `0x${'11'.repeat(20)}` as const;
const CONDITION = `0x${'22'.repeat(32)}` as const;

function signedAsk(): OffchainOrder {
  const order = buildCtfExchangeOrder({
    maker: MAKER,
    tokenId: 101n,
    side: Side.SELL,
    priceRaw: 650_000n,
    sizeRaw: 1_000_000n,
    salt: 1n,
    expiration: 2_000_000_000n,
  });
  return {
    orderHash: `0x${'33'.repeat(32)}`,
    marketId: '1',
    conditionId: CONDITION,
    tokenId: '101',
    outcome: 'YES',
    maker: MAKER,
    side: 'ASK',
    priceRaw: '650000',
    sizeRaw: '1000000',
    filledRaw: '0',
    remainingRaw: '1000000',
    status: 'OPEN',
    fillable: true,
    unfillableReason: null,
    signedOrder: ctfExchangeOrderToWire(order),
    createdAt: 1_900_000_000,
    updatedAt: 1_900_000_000,
  };
}

const miniBid: Order = {
  orderId: '7',
  marketId: '1',
  conditionId: CONDITION,
  tokenId: '101',
  outcome: 'YES',
  maker: MAKER,
  side: 'BID',
  priceRaw: '600000',
  sizeRaw: '500000',
  filledRaw: '0',
  remainingRaw: '500000',
  open: true,
  isSeed: false,
  createdAt: 1_900_000_000,
  updatedAt: 1_900_000_000,
};

const approvals: ExchangeApprovalStateResponse = {
  owner: MAKER,
  ctfApprovedForAll: false,
  collateralAllowanceRaw: '1425003',
  ctfUpdatedAt: null,
  collateralUpdatedAt: 1_900_000_000,
};

describe('Hybrid order construction', () => {
  it('builds exact collateral commitments only for tick-aligned granular orders', () => {
    const buy = buildHybridOrderCommitment({
      side: 'BID',
      priceRaw: 570_000n,
      sizeRaw: 2_500_000n,
      minimumTickSizeRaw: 1_000n,
      expiration: 2_000_000_000,
    });
    const sell = buildHybridOrderCommitment({
      side: 'ASK',
      priceRaw: 570_000n,
      sizeRaw: 2_500_000n,
      minimumTickSizeRaw: 1_000n,
      expiration: 2_000_000_000,
    });

    expect(buy.collateralRaw).toBe(1_425_000n);
    expect(sell.collateralRaw).toBe(1_425_000n);
    expect(buy.exchangeSide).toBe(Side.BUY);
    expect(sell.exchangeSide).toBe(Side.SELL);
  });

  it('rejects off-tick prices and awkward sizes before signing', () => {
    expect(() =>
      buildHybridOrderCommitment({
        side: 'ASK',
        priceRaw: 570_001n,
        sizeRaw: 2_500_000n,
        minimumTickSizeRaw: 1_000n,
        expiration: 2_000_000_000,
      }),
    ).toThrow(/tick/u);
    expect(() =>
      buildHybridOrderCommitment({
        side: 'ASK',
        priceRaw: 570_000n,
        sizeRaw: 2_500_001n,
        minimumTickSizeRaw: 1_000n,
        expiration: 2_000_000_000,
      }),
    ).toThrow(/granularity/u);
  });

  it('gates exact collateral and CTF approvals from indexed state', () => {
    expect(makerApprovalRequirement(approvals, 'BID', 1_425_003n)).toEqual({
      kind: 'COLLATERAL',
      amountRaw: 1_425_003n,
      ready: true,
    });
    expect(makerApprovalRequirement(approvals, 'BID', 1_425_004n).ready).toBe(
      false,
    );
    expect(makerApprovalRequirement(approvals, 'ASK', 1_425_004n)).toEqual({
      kind: 'CTF',
      amountRaw: null,
      ready: false,
    });
    expect(fillApprovalRequirement(approvals, signedAsk(), 500_000n)).toEqual({
      kind: 'COLLATERAL',
      amountRaw: 325_000n,
      ready: true,
    });
  });
});

describe('single live venue projection', () => {
  it('never combines MiniCLOB and Hybrid orders into one ladder', () => {
    const book: OrderBook = {
      marketId: '1',
      minimumTickSizeRaw: '1000',
      outcome: 'YES',
      tokenId: '101',
      bids: [
        { priceRaw: '600000', sizeRaw: '500000', orderCount: 1 },
      ],
      asks: [
        { priceRaw: '650000', sizeRaw: '1000000', orderCount: 1 },
      ],
      bestBidRaw: '600000',
      bestAskRaw: '650000',
      orders: [miniBid],
      offchainOrders: [signedAsk()],
    };

    const mini = orderBookForVenue(book, 'MINICLOB');
    const hybrid = orderBookForVenue(book, 'HYBRID');

    expect(mini.bids).toEqual([
      { priceRaw: '600000', sizeRaw: '500000', orderCount: 1 },
    ]);
    expect(mini.asks).toEqual([]);
    expect(mini.offchainOrders).toEqual([]);
    expect(hybrid.bids).toEqual([]);
    expect(hybrid.asks).toEqual([
      { priceRaw: '650000', sizeRaw: '1000000', orderCount: 1 },
    ]);
    expect(hybrid.orders).toEqual([]);
  });
});
