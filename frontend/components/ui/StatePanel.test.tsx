import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StatePanel } from './StatePanel';

afterEach(cleanup);

describe('StatePanel mascot control', () => {
  it('keeps the mascot by default for non-money empty states', () => {
    const rendered = render(
      <StatePanel message="Nothing here yet." title="Empty state" />,
    );
    expect(rendered.container.querySelector('svg')).not.toBeNull();
  });

  it('can render a money state without the mascot', () => {
    const rendered = render(
      <StatePanel
        message="Connect to see balances."
        showMascot={false}
        title="Portfolio unavailable"
      />,
    );
    expect(rendered.container.querySelector('svg')).toBeNull();
  });
});
