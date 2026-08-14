import type { DedupCheckResponse } from '@predex-pump/shared/rest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
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
  config: null as unknown,
  configLoading: false,
  configError: null as Error | null,
  dedup: null as DedupCheckResponse | null,
  dedupLoading: false,
  dedupError: null as Error | null,
}));

const mocks = vi.hoisted(() => ({
  configRefetch: vi.fn(),
  dedupRefetch: vi.fn(),
  dedupCheck: vi.fn(),
  recordAccountBehavior: vi.fn(async () => undefined),
  txExecute: vi.fn(async (): Promise<{ marketId: string } | null> => null),
  txReset: vi.fn(),
  buildMarketMetadata: vi.fn(() => ({
    ancillaryData: '0x01',
    metadataHash: `0x${'ab'.repeat(32)}`,
  })),
  createMarketOnArc: vi.fn(),
  invalidateQueries: vi.fn(async () => undefined),
  routerPush: vi.fn(),
  setQueryData: vi.fn(),
}));

const validConfig = {
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
};

const uniqueResponse: DedupCheckResponse = {
  available: true,
  isDuplicate: false,
  canonicalMarketId: null,
  candidates: [],
};

const duplicateResponse: DedupCheckResponse = {
  available: true,
  isDuplicate: true,
  canonicalMarketId: '42',
  candidates: [
    {
      marketId: '42',
      question: 'Will this measurable fact happen by Friday?',
      score: 0.99,
      reason: 'Same fact.',
    },
  ],
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
    setQueryData: mocks.setQueryData,
  }),
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

vi.mock('@/lib/api/hooks', () => ({
  useConfig: () => ({
    data: testState.config,
    isLoading: testState.configLoading,
    error: testState.configError,
    refetch: mocks.configRefetch,
  }),
  useDedupCheck: () => ({
    data: testState.dedup,
    isLoading: testState.dedupLoading,
    error: testState.dedupError,
    refetch: mocks.dedupRefetch,
  }),
  usePriceHistory: () => ({ data: { points: [] } }),
}));

vi.mock('@/lib/api/rest-client', () => ({
  backendRestClient: {
    dedupCheck: mocks.dedupCheck,
    recordAccountBehavior: mocks.recordAccountBehavior,
  },
}));

vi.mock('@/lib/chain/transactions', () => ({
  buildMarketMetadata: mocks.buildMarketMetadata,
  createMarketOnArc: mocks.createMarketOnArc,
}));

vi.mock('@/lib/chain/useTxFlow', () => ({
  useTxFlow: () => ({
    state: { phase: 'idle', message: 'Ready.' },
    execute: mocks.txExecute,
    reset: mocks.txReset,
    isBusy: false,
  }),
}));

afterEach(cleanup);

beforeEach(() => {
  testState.config = validConfig;
  testState.configLoading = false;
  testState.configError = null;
  testState.dedup = uniqueResponse;
  testState.dedupLoading = false;
  testState.dedupError = null;
  vi.clearAllMocks();
  mocks.dedupCheck.mockResolvedValue(uniqueResponse);
  mocks.txExecute.mockResolvedValue(null);
});

function enterValidQuestion(
  value = 'Will this measurable fact happen by Friday?',
) {
  fireEvent.change(screen.getByPlaceholderText('Will…?'), {
    target: { value },
  });
}

function openReview() {
  enterValidQuestion();
  fireEvent.click(screen.getByRole('button', { name: /Launch a market/u }));
  return screen.getByRole('dialog');
}

describe('CreateScreen market launch guardrails', () => {
  it('explains the disabled CTA on first load', () => {
    render(<CreateScreen />);

    const launch = screen.getByRole('button', { name: /Launch a market/u });
    expect(launch.hasAttribute('disabled')).toBe(true);
    expect(launch.getAttribute('aria-disabled')).toBe('true');
    expect(launch.getAttribute('aria-describedby')).toBe('launch-help');
    expect(screen.getByText('Enter a market question to continue.')).toBeTruthy();
  });

  it('gives the custom resolution duration spinbutton an accessible name', () => {
    render(<CreateScreen />);

    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));

    expect(
      screen.getByRole('spinbutton', { name: 'Custom resolution duration' }),
    ).toBeTruthy();
  });

  it('rejects a zero-width-only question as visually empty', () => {
    render(<CreateScreen />);
    const question = screen.getByPlaceholderText('Will…?');

    fireEvent.change(question, { target: { value: '\u200B\u200C\uFEFF' } });
    fireEvent.blur(question);

    expect(question.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('0/180')).toBeTruthy();
    expect(screen.getByText('Enter a question for the market.')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Launch a market/u }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not present an uncommitted category in the draft or approval review', () => {
    render(<CreateScreen />);

    expect(screen.queryByText('Category')).toBeNull();
    const dialog = openReview();
    expect(within(dialog).queryByText('Category')).toBeNull();
    expect(within(dialog).queryByText('Technology')).toBeNull();
  });

  it('hydrates a minute-boundary preview from stable initial markup', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(
      Date.UTC(2026, 7, 13, 12, 0, 59, 999),
    );
    const html = renderToString(<CreateScreen />);
    expect(html).toContain('Calculating after page loads');
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);
    clock.mockReturnValue(Date.UTC(2026, 7, 13, 12, 1, 0, 1));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <CreateScreen />);
      await Promise.resolve();
    });

    expect(
      consoleError.mock.calls.flat().join(' '),
    ).not.toMatch(/hydration|did not match/iu);
    await waitFor(() =>
      expect(container.textContent).not.toContain('Calculating after page loads'),
    );
    await act(async () => root?.unmount());
    container.remove();
    consoleError.mockRestore();
    clock.mockRestore();
  });

  it('shows a pending duplicate check and blocks opening the review', () => {
    testState.dedup = null;
    testState.dedupLoading = true;
    render(<CreateScreen />);
    enterValidQuestion();

    expect(screen.getByText('Checking for existing markets…')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Launch a market/u }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('surfaces an unavailable check and blocks launch until retry succeeds', () => {
    testState.dedup = {
      available: false,
      isDuplicate: false,
      canonicalMarketId: null,
      candidates: [],
    };
    render(<CreateScreen />);
    enterValidQuestion();

    expect(screen.getByText('Duplicate check unavailable')).toBeTruthy();
    expect(screen.getByText(/Retry the check before launching/u)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Launch a market/u }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry duplicate check' }));
    expect(mocks.dedupRefetch).toHaveBeenCalledOnce();
  });

  it('shows a duplicate warning in both the form and confirmation dialog', () => {
    testState.dedup = duplicateResponse;
    render(<CreateScreen />);
    const dialog = openReview();

    expect(screen.getAllByText('A market for this already exists')).toHaveLength(2);
    expect(
      within(dialog).getAllByText(
        'Will this measurable fact happen by Friday?',
      ),
    ).toHaveLength(2);
  });

  it('re-verifies dedup before invoking the transaction flow', async () => {
    render(<CreateScreen />);
    const dialog = openReview();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve & launch' }));

    await waitFor(() => expect(mocks.dedupCheck).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.txExecute).toHaveBeenCalledOnce());
    expect(mocks.dedupCheck).toHaveBeenCalledWith({
      question: 'Will this measurable fact happen by Friday?',
    });
    expect(mocks.dedupCheck.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txExecute.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('stops before signing when the commit-time recheck finds a new duplicate', async () => {
    mocks.dedupCheck.mockResolvedValue(duplicateResponse);
    render(<CreateScreen />);
    const dialog = openReview();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve & launch' }));

    await waitFor(() =>
      expect(
        within(dialog).getByText('A market for this already exists'),
      ).toBeTruthy(),
    );
    expect(mocks.txExecute).not.toHaveBeenCalled();
  });

  it('refreshes live contract reads before redirecting after creation', async () => {
    mocks.txExecute.mockResolvedValue({ marketId: '73' });
    render(<CreateScreen />);
    const dialog = openReview();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve & launch' }));

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalledWith('/market/73'));
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['readContract'],
    });
    expect(mocks.invalidateQueries.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.routerPush.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('renders a config failure honestly and retries it', () => {
    testState.config = null;
    testState.configError = new Error('config failed');
    render(<CreateScreen />);

    expect(screen.getByText('Config unavailable')).toBeTruthy();
    expect(screen.queryByText('Live config')).toBeNull();
    expect(screen.getByText('The live registry rules could not load.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.configRefetch).toHaveBeenCalledOnce();
  });

  it('shows the exact committed seed precision and a year in the review', () => {
    render(<CreateScreen />);
    const seedLabel = screen.getByText('Initial seed').closest('label');
    const seedInput = seedLabel?.querySelector('input');
    expect(seedInput).not.toBeNull();
    fireEvent.change(seedInput as HTMLInputElement, {
      target: { value: '1.234567' },
    });
    const dialog = openReview();

    expect(within(dialog).getByText('1.234567 USDC')).toBeTruthy();
    expect(
      within(dialog).getByText('Estimated end').parentElement?.textContent,
    ).toMatch(/\b20\d{2}\b/u);
  });
});
