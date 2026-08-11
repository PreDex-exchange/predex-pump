import type { HealthResponse } from '@predex-pump/shared/rest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IndexerLagIndicator } from './IndexerLagIndicator';

const state = vi.hoisted(() => ({
  health: null as HealthResponse | null,
}));

vi.mock('@/lib/api/hooks', () => ({
  useHealth: () => ({ data: state.health }),
}));

afterEach(cleanup);

const healthy: HealthResponse = {
  ok: true,
  chainId: 5_042_002,
  indexedBlock: 100,
  headBlock: 100,
  lagBlocks: 0,
  indexerStatus: 'healthy',
  lastSuccessfulPollAt: '2026-07-31T00:00:00.000Z',
  secondsSinceLastSuccessfulPoll: 1,
  balancesReconciled: true,
  unreconciledBalanceGapCount: 0,
  chainState: {
    ready: true,
    status: 'complete',
    attemptedBlock: 100,
    snapshotBlock: 100,
    attemptedAt: '2026-07-31T00:00:00.000Z',
    completedAt: '2026-07-31T00:00:00.000Z',
    error: null,
    issues: [],
  },
  historyGaps: [],
};

describe('IndexerLagIndicator liveness', () => {
  it('surfaces degraded and stalled states even with no reported block lag', () => {
    state.health = { ...healthy, indexerStatus: 'degraded' };
    const { rerender } = render(<IndexerLagIndicator />);
    expect(screen.getByRole('status').textContent).toContain('Indexer retrying');

    state.health = { ...healthy, ok: false, indexerStatus: 'stalled' };
    rerender(<IndexerLagIndicator />);
    expect(screen.getByRole('status').textContent).toContain('Indexer stalled');
  });

  it('stays hidden when the indexer is healthy and caught up', () => {
    state.health = healthy;
    const { container } = render(<IndexerLagIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('surfaces a failed required chain-state bootstrap', () => {
    state.health = {
      ...healthy,
      ok: false,
      indexerStatus: 'degraded',
      chainState: {
        ready: false,
        status: 'failed',
        attemptedBlock: 110,
        snapshotBlock: null,
        attemptedAt: '2026-08-12T00:00:00.000Z',
        completedAt: null,
        error: 'oracle currentSigners(1) failed in Multicall3',
        issues: ['committee-snapshot-invalid'],
      },
    };

    const status = render(<IndexerLagIndicator />).getByRole('status');
    expect(status.textContent).toContain('Chain configuration unavailable');
    expect(status.getAttribute('title')).toContain('committee-snapshot-invalid');
  });

  it('prominently surfaces an audited history gap even when caught up', () => {
    state.health = {
      ...healthy,
      indexerStatus: 'degraded',
      balancesReconciled: false,
      unreconciledBalanceGapCount: 1,
      historyGaps: [
        {
          skippedFromBlock: 101,
          skippedToBlock: 109,
          skippedBlockCount: 9,
          cursorBefore: 100,
          cursorAfter: 109,
          headBlock: 110,
          startPolicy: 'auto',
          reason: 'threshold_exceeded',
          maxBackfillBlocks: 5,
          recordedAt: '2026-08-11T12:00:00.000Z',
          balanceReconciliationStatus: 'pending',
          balanceReconciliationBlock: null,
          balanceReconciliationAttemptedAt: null,
          balanceReconciledAt: null,
          balanceReconciliationError: null,
        },
      ],
    };

    const status = render(<IndexerLagIndicator />).getByRole('status');
    expect(status.textContent).toContain('Balances unreconciled after indexer gap');
    expect(status.getAttribute('title')).toContain(
      'History skipped blocks 101-109',
    );
  });
});
