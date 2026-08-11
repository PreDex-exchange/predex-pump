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

  it('prominently surfaces an audited history gap even when caught up', () => {
    state.health = {
      ...healthy,
      indexerStatus: 'degraded',
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
        },
      ],
    };

    const status = render(<IndexerLagIndicator />).getByRole('status');
    expect(status.textContent).toContain('Indexer history gap (9 blocks)');
    expect(status.getAttribute('title')).toContain(
      'History skipped blocks 101-109',
    );
  });
});
