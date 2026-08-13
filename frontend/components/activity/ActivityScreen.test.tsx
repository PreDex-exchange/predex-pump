import type { ActivityEvent, Market } from '@predex-pump/shared/domain';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActivityScreen, parseAgentAddresses } from './ActivityScreen';

const mocks = vi.hoisted(() => ({
  activityData: {
    items: [] as ActivityEvent[],
    nextCursor: null as string | null,
  },
  activityError: null as Error | null,
  activityLoading: false,
  activityLoadingMore: false,
  activityListener: null as ((message: { event: string; data: unknown }) => void) | null,
  markets: [] as Market[],
  refetch: vi.fn(),
  loadMore: vi.fn(),
  statusListener: null as
    | ((status: 'idle' | 'connecting' | 'live' | 'reconnecting') => void)
    | null,
}));

vi.mock('@/lib/api/hooks', () => ({
  useActivity: () => ({
    data: mocks.activityData,
    error: mocks.activityError,
    isLoading: mocks.activityLoading,
    isLoadingMore: mocks.activityLoadingMore,
    loadMore: mocks.loadMore,
    refetch: mocks.refetch,
  }),
  useMarkets: () => ({
    data: { items: mocks.markets, nextCursor: null },
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/lib/api/websocket', () => ({
  backendWsClient: {
    subscribe: (
      _channel: string,
      listener: (message: { event: string; data: unknown }) => void,
    ) => {
      mocks.activityListener = listener;
      return vi.fn();
    },
    subscribeStatus: (
      listener: (
        status: 'idle' | 'connecting' | 'live' | 'reconnecting',
      ) => void,
    ) => {
      mocks.statusListener = listener;
      listener('live');
      return vi.fn();
    },
  },
}));

const AGENT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HUMAN = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TX_A = `0x${'1'.repeat(64)}` as `0x${string}`;
const TX_B = `0x${'2'.repeat(64)}` as `0x${string}`;

const market: Market = {
  id: '7',
  creator: HUMAN,
  question: 'Will Ethereum trade above $5,000 before January 1, 2027?',
  phase: 'Opened',
  conditionId: `0x${'3'.repeat(64)}`,
  questionId: `0x${'4'.repeat(64)}`,
  yesTokenId: '1',
  noTokenId: '2',
  seedRaw: '1000000',
  yesPriceRaw: '540000',
  noPriceRaw: '460000',
  graduationActivityRaw: '0',
  bookAddress: null,
  frozenYesPriceRaw: null,
  handoffSizeRaw: null,
  tradeCount: 1,
  volumeRaw: '135000',
  params: {
    seedFloorRaw: '1000000',
    seedCapRaw: '5000000',
    fCapRaw: '10000000',
    graduationMoneyInThresholdRaw: '0',
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

function trade(
  id: string,
  account: `0x${string}`,
  txHash: `0x${string}`,
): ActivityEvent {
  return {
    id,
    type: 'Trade',
    marketId: market.id,
    account,
    outcome: 'YES',
    side: 'BID',
    amountRaw: '250000',
    priceRaw: '540000',
    txHash,
    ts: 1_785_500_100,
  };
}

beforeEach(() => {
  mocks.activityData = { items: [], nextCursor: null };
  mocks.activityError = null;
  mocks.activityLoading = false;
  mocks.activityLoadingMore = false;
  mocks.activityListener = null;
  mocks.markets = [market];
  mocks.refetch.mockClear();
  mocks.loadMore.mockClear();
  mocks.statusListener = null;
});

afterEach(cleanup);

describe('ActivityScreen', () => {
  it('labels configured agent addresses case-insensitively and distinguishes humans', () => {
    mocks.activityData = {
      items: [
        trade('agent-event', AGENT.toUpperCase() as `0x${string}`, TX_A),
        trade('human-event', HUMAN, TX_B),
      ],
      nextCursor: null,
    };

    render(
      <ActivityScreen
        agentAddresses={parseAgentAddresses(` ${AGENT},${AGENT.toUpperCase()} `)}
      />,
    );

    expect(screen.getByText('Autonomous agent')).toBeTruthy();
    expect(screen.getByText('Human wallet')).toBeTruthy();
    expect(screen.getByText(/Agent 0XAAA/u)).toBeTruthy();
    expect(screen.getByText(/Human 0xbbbbb/u)).toBeTruthy();
    expect(screen.getAllByText(/0\.14 USDC/u)).toHaveLength(2);
  });

  it('appends a WebSocket activity event immediately', () => {
    render(<ActivityScreen agentAddresses={new Set([AGENT])} />);
    expect(screen.getByText('Waiting for activity…')).toBeTruthy();

    act(() => {
      mocks.activityListener?.({
        event: 'activity',
        data: trade('live-event', AGENT, TX_A),
      });
      mocks.activityListener?.({
        event: 'activity',
        data: trade('second-live-event', HUMAN, TX_B),
      });
    });

    expect(screen.queryByText('Waiting for activity…')).toBeNull();
    expect(screen.getByText('Autonomous agent')).toBeTruthy();
    expect(screen.getByText('Human wallet')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: new RegExp(TX_A, 'u') }),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: new RegExp(TX_B, 'u') }),
    ).toBeTruthy();
  });

  it('renders absolute activity timestamps with an explicit UTC zone', () => {
    mocks.activityData = {
      items: [trade('timestamped-event', HUMAN, TX_A)],
      nextCursor: null,
    };

    const rendered = render(
      <ActivityScreen agentAddresses={new Set([AGENT])} />,
    );
    const timestamp = rendered.container.querySelector('time');

    expect(timestamp?.dateTime).toBe('2026-07-31T12:15:00.000Z');
    expect(timestamp?.textContent).toMatch(/\bUTC$/u);
  });

  it('shows a clear waiting state when the indexed snapshot is empty', () => {
    const rendered = render(<ActivityScreen agentAddresses={new Set([AGENT])} />);

    expect(screen.getByText('Waiting for activity…')).toBeTruthy();
    expect(screen.getByText(/will appear here live/u)).toBeTruthy();
    expect(rendered.container.querySelector('svg')).toBeNull();
  });

  it('distinguishes indexed-history loading from a successful empty tape', () => {
    mocks.activityLoading = true;

    const rendered = render(<ActivityScreen agentAddresses={new Set([AGENT])} />);

    expect(screen.getByText('Loading indexed history…')).toBeTruthy();
    expect(screen.queryByText('Waiting for activity…')).toBeNull();
    expect(screen.getByText(/before deciding whether this tape is empty/u)).toBeTruthy();
    expect(rendered.container.querySelector('svg')).toBeNull();
  });

  it('shows the stream reconnecting state', () => {
    render(<ActivityScreen agentAddresses={new Set([AGENT])} />);

    act(() => mocks.statusListener?.('reconnecting'));
    expect(screen.getByText('Reconnecting')).toBeTruthy();
    expect(screen.getByText(/catching up from the index/u)).toBeTruthy();

    act(() => mocks.statusListener?.('live'));
    expect(screen.getByText('Live')).toBeTruthy();
  });

  it('renders a load failure distinctly from a successful empty tape', () => {
    mocks.activityError = new Error('activity unavailable');

    const rendered = render(<ActivityScreen agentAddresses={new Set([AGENT])} />);

    expect(screen.getByRole('alert').textContent).toContain(
      'Activity history could not load',
    );
    expect(screen.queryByText('Waiting for activity…')).toBeNull();
    expect(screen.getByText(/this is not an empty activity tape/u)).toBeTruthy();
    expect(rendered.container.querySelector('svg')).toBeNull();
  });

  it('exposes the next cursor through a load-older control', () => {
    mocks.activityData = {
      items: [trade('indexed-event', HUMAN, TX_A)],
      nextCursor: 'older-page',
    };
    render(<ActivityScreen agentAddresses={new Set([AGENT])} />);

    screen.getByRole('button', { name: 'Load older activity' }).click();

    expect(mocks.loadMore).toHaveBeenCalledOnce();
  });

  it('renders one graduation row for its same-transaction graduation logs', () => {
    const txHash = `0x${'3'.repeat(64)}` as const;
    mocks.activityData = {
      items: [
        {
          id: `${txHash}:1`,
          type: 'MarketGraduated',
          marketId: market.id,
          account: null,
          txHash,
          ts: 1_785_500_100,
        },
        {
          id: `${txHash}:2`,
          type: 'BookSeeded',
          marketId: market.id,
          account: null,
          txHash,
          ts: 1_785_500_100,
        },
        {
          id: `${txHash}:3`,
          type: 'BookSeeded',
          marketId: market.id,
          account: null,
          txHash,
          ts: 1_785_500_100,
        },
      ],
      nextCursor: null,
    };

    render(<ActivityScreen agentAddresses={new Set([AGENT])} />);

    const tape = screen.getByLabelText('Live on-chain activity');
    expect(within(tape).getAllByRole('listitem')).toHaveLength(1);
    expect(tape.textContent).toContain('graduated');
    expect(tape.textContent).not.toContain('seeded the first');
    expect(tape.textContent).not.toMatch(/Protocol\s{2,}graduated/u);
  });

  it('renders the outcome for a cancellation without a price', () => {
    mocks.activityData = {
      items: [
        {
          id: `${TX_A}:8`,
          type: 'OrderCancelled',
          marketId: market.id,
          account: HUMAN,
          outcome: 'NO',
          side: 'BID',
          amountRaw: '250000',
          txHash: TX_A,
          ts: 1_785_500_100,
        },
      ],
      nextCursor: null,
    };

    render(<ActivityScreen agentAddresses={new Set([AGENT])} />);

    expect(screen.getByLabelText('Live on-chain activity').textContent).toContain(
      'cancelled a 0.25 NO bid',
    );
  });

  it('does not expose environment configuration names in rendered copy', () => {
    const { container } = render(
      <ActivityScreen agentAddresses={new Set()} />,
    );

    expect(container.textContent).not.toContain('NEXT_PUBLIC_AGENT_ADDRESSES');
    expect(container.textContent).toContain('Autonomous wallet labels');
  });
});
