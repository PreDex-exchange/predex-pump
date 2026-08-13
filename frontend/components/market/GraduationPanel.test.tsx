import type { Market } from '@predex-pump/shared/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraduationStatus } from '@/lib/chain/useGraduationStatus';

import { GraduationPanel } from './GraduationPanel';
import { internalIdentifiersInRenderedOutput } from './user-facing-copy.test-utils';

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  status: {
    data: null as GraduationStatus | null,
    error: null as Error | null,
    isLoading: false,
  },
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({
    address: `0x${'c'.repeat(40)}`,
    chainId: 5_042_002,
    isConnected: true,
  }),
}));

vi.mock('@/lib/chain/useGraduationStatus', () => ({
  useGraduationStatus: () => ({
    ...mocks.status,
    isRefreshing: false,
    refetch: mocks.refetch,
  }),
}));

vi.mock('@/lib/chain/useTxFlow', () => ({
  useTxFlow: () => ({
    state: { phase: 'idle', message: 'Ready.' },
    execute: vi.fn(),
    reset: vi.fn(),
    isBusy: false,
  }),
}));

vi.mock('@/lib/chain/transactions', () => ({
  graduateOnArc: vi.fn(),
}));

const market: Market = {
  id: '15',
  creator: `0x${'a'.repeat(40)}`,
  question: 'Will this market graduate?',
  phase: 'Opened',
  conditionId: `0x${'2'.repeat(64)}`,
  questionId: `0x${'3'.repeat(64)}`,
  yesTokenId: '1501',
  noTokenId: '1502',
  seedRaw: '1000000',
  yesPriceRaw: '520000',
  noPriceRaw: '480000',
  graduationActivityRaw: '15000000',
  bookAddress: null,
  frozenYesPriceRaw: null,
  handoffSizeRaw: null,
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
  graduatedAt: null,
  resolvedAt: null,
};

const baseStatus: GraduationStatus = {
  qualified: false,
  activityMoneyInRaw: '15000000',
  activityThresholdRaw: '25000000',
  openedAt: 1_784_800_000,
  minimumTimeOpen: 3600,
  earliestGraduationAt: 1_784_803_600,
};

beforeEach(() => {
  mocks.refetch.mockReset();
  mocks.status = {
    data: null,
    error: null,
    isLoading: false,
  };
});

afterEach(cleanup);

describe('GraduationPanel user-facing copy', () => {
  it.each([
    {
      name: 'qualified',
      status: {
        data: { ...baseStatus, qualified: true },
        error: null,
        isLoading: false,
      },
      expected: 'Live graduation eligibility is confirmed.',
    },
    {
      name: 'loading',
      status: { data: null, error: null, isLoading: true },
      expected: 'Checking live graduation eligibility…',
    },
    {
      name: 'waiting for its gates',
      status: { data: baseStatus, error: null, isLoading: false },
      expected: /Gates pending · earliest time/u,
    },
    {
      name: 'unavailable',
      status: {
        data: null,
        error: new Error('graduation read failed'),
        isLoading: false,
      },
      expected: 'Live graduation eligibility is temporarily unavailable.',
    },
  ])(
    'uses plain English when live eligibility is $name',
    ({ expected, status }) => {
      mocks.status = status;

      const rendered = render(<GraduationPanel market={market} />);

      expect(screen.getByText(expected)).toBeTruthy();
      expect(internalIdentifiersInRenderedOutput(rendered.container)).toEqual([]);
    },
  );
});
