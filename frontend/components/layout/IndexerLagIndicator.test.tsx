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
});
