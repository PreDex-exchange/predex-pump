import { describe, expect, it } from 'vitest';

import {
  OFFCHAIN_WITHDRAWAL_WARNING,
  routes,
  type AccountProfileResponse,
  type SessionResponse,
  type TruthSignalResponse,
} from '../src/rest.js';

describe('truth REST contract', () => {
  it('uses the canonical paid-signal path and exports its DTO', () => {
    expect(routes.truth('42')).toBe('/truth/42');

    const response = null as TruthSignalResponse | null;
    expect(response).toBeNull();
  });
});

describe('off-chain order REST contract', () => {
  it('exports canonical order routes and an explicit non-authoritative withdrawal warning', () => {
    expect(routes.orders()).toBe('/orders');
    expect(routes.order(`0x${'a'.repeat(64)}`)).toBe(
      `/orders/0x${'a'.repeat(64)}`,
    );
    expect(OFFCHAIN_WITHDRAWAL_WARNING).toContain(
      'on-chain cancellation is authoritative',
    );
    expect(OFFCHAIN_WITHDRAWAL_WARNING).toContain('cancelOrder/cancelAll');
  });
});

describe('account REST contract', () => {
  it('exports canonical SIWE and per-account feature paths', () => {
    expect(routes.siweNonce()).toBe('/auth/siwe/nonce');
    expect(routes.siweVerify()).toBe('/auth/siwe/verify');
    expect(routes.session()).toBe('/auth/session');
    expect(routes.signOut()).toBe('/auth/sign-out');
    expect(routes.accountProfile()).toBe('/account/profile');
    expect(routes.accountWatchlist('42')).toBe('/account/watchlist/42');
    expect(routes.accountBehavior()).toBe('/account/behavior');
    expect(routes.gatewayBalance()).toBe('/account/gateway/balance');
    expect(routes.exchangeApprovals(`0x${'a'.repeat(40)}`)).toBe(
      `/accounts/0x${'a'.repeat(40)}/exchange-approvals`,
    );

    const session = null as SessionResponse | null;
    const profile = null as AccountProfileResponse | null;
    expect(session).toBeNull();
    expect(profile).toBeNull();
  });
});
