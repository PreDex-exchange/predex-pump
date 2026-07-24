import { describe, expect, it } from 'vitest';

import {
  averagePriceRaw,
  decodeQuestion,
  deriveResolution,
  marginalPricesRaw,
  oppositeSide,
  outcomeFromIndex,
  sideFromIndex,
} from '../src/indexer/derive.js';

describe('indexer derivations', () => {
  it('decodes UTF-8 ancillary data and preserves undecodable bytes', () => {
    expect(decodeQuestion('0x57696c6c2041726320736869703f')).toBe('Will Arc ship?');
    expect(decodeQuestion('0xff')).toBe('0xff');
  });

  it('derives a normalized binary LMSR price pair', () => {
    expect(marginalPricesRaw(10_000_000n, 10_000_000n, 5_000_000_000_000_000_000n)).toEqual({
      yesPriceRaw: '500000',
      noPriceRaw: '500000',
    });
    const bullish = marginalPricesRaw(
      15_000_000n,
      10_000_000n,
      5_000_000_000_000_000_000n,
    );
    expect(BigInt(bullish.yesPriceRaw)).toBeGreaterThan(500_000n);
    expect(BigInt(bullish.yesPriceRaw) + BigInt(bullish.noPriceRaw)).toBe(1_000_000n);
    // Live Arc TradeState snapshot; matches MarketGraduationBookSeeded exactly.
    expect(marginalPricesRaw(100_000n, 0n, 1_442_695_040_888_963_406n)).toEqual({
      yesPriceRaw: '517321',
      noPriceRaw: '482679',
    });
  });

  it('derives effective prices with half-up integer rounding', () => {
    expect(averagePriceRaw(2_000_000n, 1_250_000n)).toBe('625000');
    expect(averagePriceRaw(0n, 1_250_000n)).toBe('0');
  });

  it('maps binary enum indices and taker side', () => {
    expect(outcomeFromIndex(0n)).toBe('YES');
    expect(outcomeFromIndex(1n)).toBe('NO');
    expect(sideFromIndex(0n)).toBe('BID');
    expect(oppositeSide('BID')).toBe('ASK');
  });

  it('derives valid and invalid payout resolutions', () => {
    expect(deriveResolution([1n, 0n])).toEqual({
      outcome: 'YES',
      payoutYes: 1,
      payoutNo: 0,
      denominator: 1,
    });
    expect(deriveResolution([1n, 1n])).toEqual({
      outcome: 'INVALID',
      payoutYes: 1,
      payoutNo: 1,
      denominator: 2,
    });
  });
});
