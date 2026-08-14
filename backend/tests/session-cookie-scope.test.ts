import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadAccountLayerConfig } from '../src/account/config.js';
import {
  SESSION_COOKIE_NAME,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from '../src/account/service.js';

// The pump backend can be served from the same hostname as the pairing stack
// (api.predex.exchange/pump/). A browser scopes a cookie by the URL path it
// requested, so a `Path=/` session cookie would be attached to every request to
// that host — including the other tenant's /aggregator/, /exchange/ and /sync/
// routes. The reverse proxy strips the prefix before the backend sees it, so
// the scope can only come from configuration.
describe('session cookie scope', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function configWith(path: string | undefined) {
    vi.stubEnv('PREDEX_WEB_ORIGIN', 'https://pump.predex.exchange');
    if (path === undefined) vi.stubEnv('ACCOUNT_COOKIE_PATH', '');
    else vi.stubEnv('ACCOUNT_COOKIE_PATH', path);
    return loadAccountLayerConfig();
  }

  it('confines the cookie to the configured prefix', () => {
    const cookie = serializeSessionCookie(
      'token',
      new Date(Date.now() + 60_000),
      configWith('/pump'),
    );
    expect(cookie).toContain('Path=/pump');
    expect(cookie).not.toContain('Path=/;');
  });

  it('clears using the same Path it set', () => {
    // A browser matches name+domain+path on delete. Clearing at '/' would leave
    // the '/pump' cookie in place and make sign-out silently fail.
    const config = configWith('/pump');
    expect(serializeClearedSessionCookie(config)).toContain('Path=/pump');
  });

  it('treats a trailing slash as the same scope', () => {
    expect(configWith('/pump/').cookiePath).toBe('/pump');
  });

  it('defaults to the whole host when unset', () => {
    expect(configWith(undefined).cookiePath).toBe('/');
  });

  it('rejects a path that cannot scope a cookie', () => {
    expect(() => configWith('pump')).toThrow(/must start with/u);
  });

  it('does not reuse the pairing stack cookie name', () => {
    expect(SESSION_COOKIE_NAME).not.toBe('predex_session');
  });
});
