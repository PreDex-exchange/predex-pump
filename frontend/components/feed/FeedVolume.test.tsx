import type { Market } from '@predex-pump/shared/domain';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Hero } from './Hero';
import { MarketCard } from './MarketCard';

const mocks = vi.hoisted(() => ({
  usePriceHistory: vi.fn(),
}));

vi.mock('@/lib/api/hooks', () => ({
  usePriceHistory: mocks.usePriceHistory,
}));

function market(volumeRaw: string): Market {
  return {
    id: '1',
    creator: `0x${'a'.repeat(40)}`,
    question: 'Will small volume remain visible?',
    phase: 'Opened',
    conditionId: `0x${'1'.repeat(64)}`,
    questionId: `0x${'2'.repeat(64)}`,
    yesTokenId: '1',
    noTokenId: '2',
    seedRaw: '1000000',
    yesPriceRaw: '540000',
    noPriceRaw: '460000',
    graduationActivityRaw: '0',
    bookAddress: null,
    frozenYesPriceRaw: null,
    handoffSizeRaw: null,
    tradeCount: 0,
    volumeRaw,
    params: {
      seedFloorRaw: '1000000',
      seedCapRaw: '5000000',
      fCapRaw: '10000000',
      graduationMoneyInThresholdRaw: '10000000',
      graduationTollRaw: '100000',
      inventoryTargetRaw: '20000000',
      protocolFeeBps: 20,
      depthFeeBps: 0,
      tradingWindowSeconds: 2592000,
      minimumTimeOpenSeconds: 0,
      minimumTickSizeRaw: '1000',
    },
    createdAt: 1_785_500_000,
    tradingEndsAt: 1_788_092_000,
    graduatedAt: null,
    resolvedAt: null,
  };
}

afterEach(() => {
  cleanup();
  mocks.usePriceHistory.mockReset();
});

describe('feed volume display', () => {
  it('requests only the latest compact sparkline sample', () => {
    mocks.usePriceHistory.mockReturnValue({ data: { points: [] } });
    render(<MarketCard market={market('0')} />);

    expect(mocks.usePriceHistory).toHaveBeenCalledWith('1', { limit: 32 });
  });

  it('marks loaded statistics as lower bounds while another page exists', () => {
    mocks.usePriceHistory.mockReturnValue({ data: { points: [] } });
    const snapshot = market('5000');
    render(<Hero hasMore markets={[snapshot]} />);

    const statistics = screen.getByRole('list', { name: 'Platform statistics' });
    expect(within(statistics).getByText('1+')).toBeTruthy();
    expect(within(statistics).getByText('$0.01+')).toBeTruthy();
  });

  it.each([
    ['0', '$0.00'],
    ['1', '<$0.01'],
    ['4000', '<$0.01'],
    ['5000', '$0.01'],
    ['999999', '$1.00'],
    ['123456789012', '$123,456.79'],
  ])('renders raw volume %s at its real magnitude', (volumeRaw, expected) => {
    mocks.usePriceHistory.mockReturnValue({ data: { points: [] } });
    const snapshot = market(volumeRaw);
    render(
      <>
        <Hero markets={[snapshot]} />
        <MarketCard market={snapshot} />
      </>,
    );

    expect(
      within(screen.getByRole('list', { name: 'Platform statistics' })).getByText(
        expected,
      ),
    ).toBeTruthy();
    expect(screen.getByText(`${expected} vol`)).toBeTruthy();
  });
});
