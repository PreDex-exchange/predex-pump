import type { Market, Position, Resolution } from '@predex-pump/shared/domain';
import { describe, expect, it } from 'vitest';

import {
  displayMarketPhase,
  isMarketSettled,
  marketPriceRaw,
  positionCurrentValueRaw,
  resolvedOutcome,
} from './market-state';

const resolution: Resolution = {
  marketId: '2',
  conditionId: `0x${'2'.repeat(64)}`,
  outcome: 'YES',
  payoutYes: 1,
  payoutNo: 0,
  denominator: 1,
  resolvedAt: 1_784_918_616,
  observedAt: null,
};

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: '2',
    creator: `0x${'a'.repeat(40)}`,
    question: 'Did the final payout settle YES?',
    phase: 'Graduated',
    conditionId: resolution.conditionId,
    questionId: `0x${'3'.repeat(64)}`,
    yesTokenId: '201',
    noTokenId: '202',
    seedRaw: '1000000',
    yesPriceRaw: '520000',
    noPriceRaw: '480000',
    graduationActivityRaw: '25000000',
    bookAddress: `0x${'b'.repeat(40)}`,
    frozenYesPriceRaw: '520000',
    handoffSizeRaw: '5000000',
    tradeCount: 1,
    volumeRaw: '50000',
    params: {
      seedFloorRaw: '1000000',
      seedCapRaw: '50000000',
      fCapRaw: '100000000',
      graduationMoneyInThresholdRaw: '25000000',
      graduationTollRaw: '2000000',
      inventoryTargetRaw: '5000000',
      protocolFeeBps: 100,
      depthFeeBps: 50,
      tradingWindowSeconds: 86400,
      minimumTimeOpenSeconds: 3600,
      minimumTickSizeRaw: '1000',
    },
    createdAt: 1_784_800_000,
    tradingEndsAt: 1_784_886_400,
    graduatedAt: 1_784_803_600,
    resolvedAt: resolution.resolvedAt,
    resolution,
    ...overrides,
  };
}

const winningPosition: Position = {
  account: `0x${'c'.repeat(40)}`,
  marketId: '2',
  outcome: 'YES',
  qtyRaw: '1000000',
  costBasisRaw: '50000',
  costBasisEstimated: true,
  realizedPnlRaw: '0',
  unrealizedPnlRaw: '950000',
  updatedAt: resolution.resolvedAt,
};

describe('settled market projection', () => {
  it.each([
    ['embedded payout', market()],
    [
      'resolved timestamp with an older payload',
      market({ resolution: undefined }),
    ],
    [
      'observed lifecycle',
      market({
        phase: 'ResolvedObserved',
        resolvedAt: null,
        resolution: undefined,
        yesPriceRaw: '1000000',
        noPriceRaw: '0',
      }),
    ],
    [
      'closed lifecycle',
      market({
        phase: 'ClosedOut',
        resolvedAt: null,
        resolution: undefined,
        yesPriceRaw: '1000000',
        noPriceRaw: '0',
      }),
    ],
  ])('treats %s as settled independently of Graduated', (_label, snapshot) => {
    expect(isMarketSettled(snapshot)).toBe(true);
    expect(displayMarketPhase(snapshot)).not.toBe('Graduated');
  });

  it('uses the payout for prices and a winning position value', () => {
    const snapshot = market();
    expect(resolvedOutcome(snapshot)).toBe('YES');
    expect(marketPriceRaw(snapshot, 'YES')).toBe('1000000');
    expect(marketPriceRaw(snapshot, 'NO')).toBe('0');
    expect(positionCurrentValueRaw(winningPosition, snapshot)).toBe('1000000');
  });

  it('uses the indexer payout mark rather than a stale marginal for older snapshots', () => {
    expect(
      positionCurrentValueRaw(
        winningPosition,
        market({ resolution: undefined }),
      ),
    ).toBe('1000000');
  });
});
