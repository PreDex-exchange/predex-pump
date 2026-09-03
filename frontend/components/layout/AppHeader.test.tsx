import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppHeader } from './AppHeader';

const mocks = vi.hoisted(() => ({ pathname: '/' }));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
}));

vi.mock('./IndexerLagIndicator', () => ({
  IndexerLagIndicator: () => null,
}));

vi.mock('./WalletBar', () => ({
  WalletBar: () => <button type="button">Wallet</button>,
}));

afterEach(() => {
  cleanup();
  mocks.pathname = '/';
});

describe('responsive application navigation', () => {
  it('exposes all five product destinations from one navigation landmark', () => {
    render(<AppHeader />);

    const navigation = screen.getByRole('navigation', {
      name: 'Primary navigation',
    });
    expect(
      within(navigation)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Markets', 'Activity', 'Create', 'Portfolio', 'Account']);
  });

  it('keeps Markets current while a user is inside a market', () => {
    mocks.pathname = '/market/208';
    render(<AppHeader />);

    expect(
      screen
        .getByRole('link', { name: 'Markets' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen
        .getByRole('link', { name: 'Activity' })
        .hasAttribute('aria-current'),
    ).toBe(false);
  });
});
