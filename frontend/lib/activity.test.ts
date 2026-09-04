import type { ActivityEvent, Market } from '@predex-pump/shared/domain';
import { describe, expect, it } from 'vitest';

import { dedupeActivityEvents, describeActivityEvent } from './activity';

const TX = `0x${'1'.repeat(64)}` as const;

const market = {
  id: '7',
  question: 'Will the shared activity vocabulary stay consistent?',
} as Market;

function event(
  type: ActivityEvent['type'],
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    id: `${TX}:1`,
    type,
    marketId: market.id,
    account: `0x${'a'.repeat(40)}`,
    txHash: TX,
    ts: 1_785_500_100,
    ...overrides,
  };
}

describe('activity descriptions', () => {
  it('uses the event side to distinguish otherwise identical buys and sells', () => {
    const fields = {
      amountRaw: '250000',
      outcome: 'YES' as const,
      priceRaw: '540000',
    };

    const buy = describeActivityEvent(
      event('Trade', { ...fields, side: 'BID' }),
      [market],
    );
    const sell = describeActivityEvent(
      event('Trade', { ...fields, side: 'ASK' }),
      [market],
    );

    expect(buy.text).toContain('bought 0.25 YES shares');
    expect(sell.text).toContain('sold 0.25 YES shares');
    expect(buy.text).not.toBe(sell.text);
  });

  it('keeps the outcome in a cancellation that has no price', () => {
    const description = describeActivityEvent(
      event('OrderCancelled', {
        amountRaw: '250000',
        outcome: 'NO',
        side: 'BID',
      }),
      [market],
    );

    expect(description.text).toContain('cancelled a 0.25 NO bid');
  });

  it.each([
    ['YES', 'BID'],
    ['NO', 'ASK'],
  ] as const)(
    'names a missing-amount %s cancellation without a placeholder',
    (outcome, side) => {
      const description = describeActivityEvent(
        event('OrderCancelled', { outcome, side }),
        [market],
      );

      expect(description.text).toBe(
        `cancelled a ${outcome} order on “${market.question}”.`,
      );
      expect(description.text).not.toContain('—');
    },
  );

  it('names a cancellation with no amount or outcome without a placeholder', () => {
    const description = describeActivityEvent(
      event('OrderCancelled', { side: 'ASK' }),
      [market],
    );

    expect(description.text).toBe(
      `cancelled an order on “${market.question}”.`,
    );
    expect(description.text).not.toContain('—');
  });

  it('keeps sub-cent prices and notionals distinguishable from zero', () => {
    const description = describeActivityEvent(
      event('Trade', {
        amountRaw: '1000000',
        outcome: 'YES',
        priceRaw: '4000',
        side: 'BID',
      }),
      [market],
    );

    expect(description.text).toContain('at <$0.01');
    expect(description.text).toContain('for about <0.01 USDC');
  });

  it('keeps a sub-display share quantity distinguishable from zero', () => {
    const description = describeActivityEvent(
      event('Trade', {
        amountRaw: '1',
        outcome: 'YES',
        priceRaw: '500000',
        side: 'BID',
      }),
      [market],
    );

    expect(description.text).toContain('bought <0.01 YES shares');
    expect(description.text).not.toContain('bought 0 YES shares');
  });

  it('names BookSeeded independently from graduation', () => {
    const description = describeActivityEvent(event('BookSeeded'), [market]);

    expect(description.label).toBe('Book seeded');
    expect(description.text).toContain('seeded the first order-book depth');
  });
});

describe('activity event dedupe', () => {
  it('collapses graduation implementation logs from one transaction to one semantic row', () => {
    const events = [
      event('MarketGraduated', { id: `${TX}:1` }),
      event('BookSeeded', { id: `${TX}:2` }),
      event('BookSeeded', { id: `${TX}:3` }),
    ];

    expect(dedupeActivityEvents(events)).toEqual([events[0]]);
  });

  it.each(['ResolutionObserved', 'Closeout'] as const)(
    'keeps the first %s row when wrapper logs share a normalized transaction and market',
    (type) => {
      const lowerTx = `0x${'a'.repeat(64)}` as const;
      const upperTx = `0x${'A'.repeat(64)}` as const;
      const events = [
        event(type, { id: `${lowerTx}:4`, txHash: lowerTx }),
        event(type, { id: `${upperTx}:9`, txHash: upperTx }),
      ];

      expect(dedupeActivityEvents(events)).toEqual([events[0]]);
    },
  );

  it('retains resolution rows separated by transaction, market, or semantic type', () => {
    const firstTx = `0x${'b'.repeat(64)}` as const;
    const secondTx = `0x${'c'.repeat(64)}` as const;
    const events = [
      event('ResolutionObserved', { id: `${firstTx}:1`, txHash: firstTx }),
      event('ResolutionObserved', { id: `${secondTx}:1`, txHash: secondTx }),
      event('ResolutionObserved', {
        id: `${firstTx}:2`,
        marketId: '8',
        txHash: firstTx,
      }),
      event('Closeout', { id: `${firstTx}:3`, txHash: firstTx }),
    ];

    expect(dedupeActivityEvents(events)).toEqual(events);
  });
});
