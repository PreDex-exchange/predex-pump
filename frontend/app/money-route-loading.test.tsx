import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import FeedLoading from './loading';
import AccountLoading from './account/loading';
import MarketLoading from './market/[id]/loading';
import PortfolioLoading from './portfolio/loading';

afterEach(cleanup);

describe('money route loading states', () => {
  it.each([
    ['feed', FeedLoading],
    ['account', AccountLoading],
    ['market', MarketLoading],
    ['portfolio', PortfolioLoading],
  ] as const)('keeps the mascot off the %s route', (_route, LoadingState) => {
    const rendered = render(<LoadingState />);

    expect(rendered.container.querySelector('svg')).toBeNull();
  });
});
