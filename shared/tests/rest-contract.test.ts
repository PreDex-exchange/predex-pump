import { describe, expect, it } from 'vitest';

import {
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

describe('account REST contract', () => {
  it('exports canonical SIWE and per-account feature paths', () => {
    expect(routes.siweNonce()).toBe('/auth/siwe/nonce');
    expect(routes.siweVerify()).toBe('/auth/siwe/verify');
    expect(routes.session()).toBe('/auth/session');
    expect(routes.signOut()).toBe('/auth/sign-out');
    expect(routes.accountProfile()).toBe('/account/profile');
    expect(routes.accountWatchlist('42')).toBe('/account/watchlist/42');
    expect(routes.accountBehavior()).toBe('/account/behavior');

    const session = null as SessionResponse | null;
    const profile = null as AccountProfileResponse | null;
    expect(session).toBeNull();
    expect(profile).toBeNull();
  });
});
