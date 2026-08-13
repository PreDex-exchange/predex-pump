import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ErrorPage from './error';
import NotFound from './not-found';

afterEach(cleanup);

describe('route-level branded states', () => {
  it('renders the branded not-found state for an unknown route', () => {
    render(<NotFound />);

    expect(
      screen.getByRole('heading', { name: 'That page never hatched' }),
    ).toBeTruthy();
    expect(
      screen.getByText('The address does not match a page in this incubator.'),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Return to feed' }).getAttribute('href'),
    ).toBe('/');
  });

  it('renders a recoverable branded route error', () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error('private failure')} reset={reset} />);

    expect(
      screen.getByRole('heading', { name: 'Something cracked' }),
    ).toBeTruthy();
    expect(screen.queryByText('private failure')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
