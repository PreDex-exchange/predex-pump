import type { ActivityEvent, Market } from '@predex-pump/shared/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActivityList } from './ActivityList';

const TX = `0x${'1'.repeat(64)}` as const;
const ACCOUNT = `0x${'a'.repeat(40)}` as const;
const market = { id: '7', question: 'Will one event produce one row?' } as Market;

function event(
  type: ActivityEvent['type'],
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    id: `${TX}:1`,
    type,
    marketId: market.id,
    account: ACCOUNT,
    txHash: TX,
    ts: 1_785_500_100,
    ...overrides,
  };
}

afterEach(cleanup);

describe('feed activity list', () => {
  it('announces load failures, suppresses empty copy, and offers retry', () => {
    const retry = vi.fn();
    render(
      <ActivityList
        emptyMessage="No account activity yet."
        error={new Error('activity unavailable')}
        events={[]}
        markets={[market]}
        onRetry={retry}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'This is not an empty activity state',
    );
    expect(screen.queryByText('No account activity yet.')).toBeNull();
    screen.getByRole('button', { name: 'Try activity again' }).click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('renders one graduation row for its three same-transaction logs', () => {
    render(
      <ActivityList
        events={[
          event('MarketGraduated', { id: `${TX}:1` }),
          event('BookSeeded', { id: `${TX}:2` }),
          event('BookSeeded', { id: `${TX}:3` }),
        ]}
        markets={[market]}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Graduated')).toBeTruthy();
    expect(screen.queryByText('Book seeded')).toBeNull();
  });

  it('renders identical buy and sell sizes with different language', () => {
    const fields = {
      amountRaw: '250000',
      outcome: 'YES' as const,
      priceRaw: '540000',
    };
    render(
      <ActivityList
        events={[
          event('Trade', { ...fields, id: `${TX}:4`, side: 'BID' }),
          event('Trade', {
            ...fields,
            id: `${TX}:5`,
            side: 'ASK',
            txHash: `0x${'2'.repeat(64)}`,
          }),
        ]}
        markets={[market]}
      />,
    );

    const rows = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows.some((row) => row?.includes('bought 0.25 YES shares'))).toBe(true);
    expect(rows.some((row) => row?.includes('sold 0.25 YES shares'))).toBe(true);
  });

  it('renders the outcome for a cancellation without a price', () => {
    render(
      <ActivityList
        events={[
          event('OrderCancelled', {
            amountRaw: '250000',
            outcome: 'NO',
            side: 'BID',
          }),
        ]}
        markets={[market]}
      />,
    );

    expect(screen.getByRole('listitem').textContent).toContain(
      'cancelled a 0.25 NO bid',
    );
    expect(screen.getByRole('listitem').textContent).toContain(
      'Human 0xaaaaa…aaaa',
    );
  });

  it('uses a cancellation badge distinct from market creation', () => {
    render(
      <ActivityList
        events={[
          event('OrderCancelled', { id: `${TX}:cancelled` }),
          event('MarketCreated', {
            id: `${TX}:created`,
            txHash: `0x${'2'.repeat(64)}`,
          }),
        ]}
        markets={[market]}
      />,
    );

    expect(screen.getByText('Cancelled').className).not.toBe(
      screen.getByText('Created').className,
    );
  });

  it('applies the visible limit after semantic deduplication', () => {
    const events = Array.from({ length: 7 }, (_, index) =>
      event('Trade', {
        id: `${TX}:${index}`,
        txHash: `0x${String(index + 1).repeat(64)}`,
      }),
    );
    render(<ActivityList events={events} limit={5} markets={[market]} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });
});
