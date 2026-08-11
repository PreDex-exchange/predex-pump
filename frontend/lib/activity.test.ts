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
});
