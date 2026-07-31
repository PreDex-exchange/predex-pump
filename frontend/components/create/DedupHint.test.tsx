import type { DedupCheckResponse } from '@predex-pump/shared/rest';
import {
  cleanup,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DedupHint } from './DedupHint';

afterEach(cleanup);

const duplicate: DedupCheckResponse = {
  available: true,
  isDuplicate: true,
  canonicalMarketId: '42',
  candidates: [
    {
      marketId: '42',
      score: 0.9842,
      reason: 'The normalized subject and deadline match.',
    },
  ],
};

describe('DedupHint', () => {
  it('renders duplicate candidates and links to the canonical market', () => {
    render(<DedupHint response={duplicate} />);

    expect(
      screen.getByText('A market for this already exists'),
    ).toBeTruthy();
    expect(screen.getByText('Market #42')).toBeTruthy();
    expect(screen.getByText('score 0.984')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: /Trade it instead/u })
        .getAttribute('href'),
    ).toBe('/market/42');
  });

  it('renders nothing when the advisory service is degraded', () => {
    const { container } = render(
      <DedupHint
        response={{
          available: false,
          isDuplicate: false,
          canonicalMarketId: null,
          candidates: [],
        }}
      />,
    );

    expect(container.innerHTML).toBe('');
    expect(
      screen.queryByText('A market for this already exists'),
    ).toBeNull();
  });
});
