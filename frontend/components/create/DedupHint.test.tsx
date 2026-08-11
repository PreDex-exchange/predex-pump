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
      question: 'Will BTC close above $70k Friday?',
      score: 0.9842,
      reason: 'The normalized subject and deadline match.',
    },
    {
      marketId: '7',
      question: 'Will ETH close above $70k Friday?',
      score: 0.93,
      reason: 'Different subject.',
    },
  ],
};

describe('DedupHint', () => {
  it('renders duplicate candidates and links to the canonical market', () => {
    render(<DedupHint response={duplicate} />);

    expect(
      screen.getByText('A market for this already exists'),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', {
        name: 'Will BTC close above $70k Friday?',
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Market #/u)).toBeNull();
    expect(screen.queryByText(/score 0\.984/u)).toBeNull();
    expect(screen.queryByText('Will ETH close above $70k Friday?')).toBeNull();
    expect(screen.queryByText('Different subject.')).toBeNull();
    expect(
      screen
        .getByRole('link', { name: /Trade it instead/u })
        .getAttribute('href'),
    ).toBe('/market/42');
  });

  it('renders an unavailable state that is distinct from a clear result', () => {
    const { rerender } = render(
      <DedupHint
        response={{
          available: false,
          isDuplicate: false,
          canonicalMarketId: null,
          candidates: [],
        }}
      />,
    );

    expect(screen.getByText('Duplicate check unavailable')).toBeTruthy();
    expect(screen.queryByText('No matching market found')).toBeNull();

    rerender(
      <DedupHint
        response={{
          available: true,
          isDuplicate: false,
          canonicalMarketId: null,
          candidates: [],
        }}
      />,
    );

    expect(screen.getByText('No matching market found')).toBeTruthy();
    expect(screen.queryByText('Duplicate check unavailable')).toBeNull();
  });

  it('shows when a duplicate check is pending', () => {
    render(<DedupHint pending response={null} />);

    expect(screen.getByText('Checking for existing markets…')).toBeTruthy();
  });
});
