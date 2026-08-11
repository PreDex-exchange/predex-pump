import {
  ALLOWED_MINIMUM_TICK_SIZES_RAW,
  ORDER_PRICE_SCALE_RAW,
  ORDER_SIZE_GRANULARITY_RAW,
  isAllowedMinimumTickSizeRaw,
  fillSizePreservingRepresentableRemainder,
  leavesRepresentableRemainder,
} from '../src/orderbook.js';
import {
  Side,
  buildCtfExchangeOrder,
  ctfExchangeOrderTerms,
} from '../src/tx/orders.js';
import { describe, expect, it } from 'vitest';

const MAKER = `0x${'11'.repeat(20)}` as const;

describe('per-market order-book ticks', () => {
  it('round-trips every on-tick price exactly for both sides across awkward granular sizes', () => {
    const sizes = [
      1_000n,
      7_000n,
      123_000n,
      450_000n,
      451_000n,
      899_000n,
      900_000n,
      1_337_000n,
      2_503_000n,
    ];

    for (const tickSizeRaw of ALLOWED_MINIMUM_TICK_SIZES_RAW) {
      expect(ORDER_PRICE_SCALE_RAW % tickSizeRaw).toBe(0n);
      for (
        let priceRaw = tickSizeRaw;
        priceRaw <= ORDER_PRICE_SCALE_RAW;
        priceRaw += tickSizeRaw
      ) {
        for (const sizeRaw of sizes) {
          expect(sizeRaw % ORDER_SIZE_GRANULARITY_RAW).toBe(0n);
          for (const side of [Side.BUY, Side.SELL] as const) {
            const order = buildCtfExchangeOrder({
              maker: MAKER,
              tokenId: 1n,
              side,
              priceRaw,
              sizeRaw,
              salt: 1n,
            });
            expect(ctfExchangeOrderTerms(order)).toEqual({
              priceRaw,
              sizeRaw,
            });
          }
        }
      }
    }
  });

  it('keeps the unsafe 100-raw tick outside the closed allow-list', () => {
    expect(isAllowedMinimumTickSizeRaw(1_000n)).toBe(true);
    expect(isAllowedMinimumTickSizeRaw(10_000n)).toBe(true);
    expect(isAllowedMinimumTickSizeRaw(100_000n)).toBe(true);
    expect(isAllowedMinimumTickSizeRaw(100n)).toBe(false);
  });

  it('allows only full fills or partial fills with a granular remainder', () => {
    expect(leavesRepresentableRemainder(450_123n, 123n)).toBe(true);
    expect(leavesRepresentableRemainder(450_123n, 450_123n)).toBe(true);
    expect(leavesRepresentableRemainder(450_123n, 1_000n)).toBe(false);
    expect(leavesRepresentableRemainder(450_000n, 123_000n)).toBe(true);
    expect(
      fillSizePreservingRepresentableRemainder(450_123n, 100_000n),
    ).toBe(99_123n);
  });
});
