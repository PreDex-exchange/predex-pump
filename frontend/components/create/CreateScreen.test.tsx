import type {
  DedupCheckResponse,
} from '@predex-pump/shared/rest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { CreateScreen } from './CreateScreen';

const testState = vi.hoisted(() => ({
  dedup: null as DedupCheckResponse | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: `0x${'12'.repeat(20)}`,
    chainId: 5_042_002,
    isConnected: true,
  }),
  useConnect: () => ({
    connect: vi.fn(),
    connectors: [],
    error: null,
    isPending: false,
  }),
}));

vi.mock('@/components/feed/MarketCard', () => ({
  MarketCard: () => <div aria-label="market preview" />,
}));

vi.mock('@/lib/api/hooks', () => ({
  useConfig: () => ({
    data: {
      chainId: 5_042_002,
      addresses: {
        usdc: `0x${'01'.repeat(20)}`,
        ctf: `0x${'02'.repeat(20)}`,
        oracle: `0x${'03'.repeat(20)}`,
        lmsr: `0x${'04'.repeat(20)}`,
        registry: `0x${'05'.repeat(20)}`,
        miniClob: `0x${'06'.repeat(20)}`,
      },
      marketTypeVersion: 1,
      seedFloorRaw: '1000000',
      seedCapRaw: '100000000',
      graduationTollRaw: '1000000',
      protocolFeeBps: 100,
      minTradingWindowSeconds: 3_600,
      maxTradingWindowSeconds: 604_800,
      committee: {
        oracle: `0x${'03'.repeat(20)}`,
        signers: [`0x${'07'.repeat(20)}`],
        threshold: 1,
      },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useDedupCheck: () => ({
    data: testState.dedup,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/lib/chain/transactions', () => ({
  buildMarketMetadata: vi.fn(),
  createMarketOnArc: vi.fn(),
}));

vi.mock('@/lib/chain/useTxFlow', () => ({
  useTxFlow: () => ({
    state: { phase: 'idle', message: 'Ready.' },
    execute: vi.fn(),
    reset: vi.fn(),
    isBusy: false,
  }),
}));

afterEach(cleanup);

beforeEach(() => {
  testState.dedup = null;
});

function enterValidQuestion() {
  fireEvent.change(screen.getByPlaceholderText('Will…?'), {
    target: { value: 'Will this measurable fact happen by Friday?' },
  });
}

describe('CreateScreen dedup advisory', () => {
  it('shows a duplicate hint without disabling the submit path', () => {
    testState.dedup = {
      available: true,
      isDuplicate: true,
      canonicalMarketId: '42',
      candidates: [
        { marketId: '42', score: 0.99, reason: 'Same fact.' },
      ],
    };
    render(<CreateScreen />);
    enterValidQuestion();

    expect(
      screen.getByText('A market for this already exists'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: /Launch a market/u })
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  it('stays silent and keeps submit enabled when dedup is unavailable', () => {
    testState.dedup = {
      available: false,
      isDuplicate: false,
      canonicalMarketId: null,
      candidates: [],
    };
    render(<CreateScreen />);
    enterValidQuestion();

    expect(
      screen.queryByText('A market for this already exists'),
    ).toBeNull();
    expect(
      screen
        .getByRole('button', { name: /Launch a market/u })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
});
