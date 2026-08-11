import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
} from 'next/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';

import nextConfig from '../next.config.ts';
import { assertQaServerEnvironment } from './server.mjs';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('QA wallet production gate', () => {
  it('bakes an empty provider URL into production even when QA flags are set', () => {
    vi.stubEnv('QA_WALLET_ENABLED', '1');
    vi.stubEnv(
      'QA_WALLET_SCRIPT_URL',
      'http://127.0.0.1:3003/provider.js',
    );

    const config = nextConfig(PHASE_PRODUCTION_BUILD);

    expect(config.env?.PREDEX_QA_WALLET_SCRIPT_URL).toBe('');
  });

  it('exposes the provider URL only to an explicitly enabled dev server', () => {
    vi.stubEnv('QA_WALLET_ENABLED', '1');
    vi.stubEnv(
      'QA_WALLET_SCRIPT_URL',
      'http://127.0.0.1:3003/provider.js',
    );

    const config = nextConfig(PHASE_DEVELOPMENT_SERVER);

    expect(config.env?.PREDEX_QA_WALLET_SCRIPT_URL).toBe(
      'http://127.0.0.1:3003/provider.js',
    );
  });

  it('rejects a non-loopback provider URL in development', () => {
    vi.stubEnv('QA_WALLET_ENABLED', '1');
    vi.stubEnv('QA_WALLET_SCRIPT_URL', 'https://example.com/provider.js');

    expect(() => nextConfig(PHASE_DEVELOPMENT_SERVER)).toThrow(
      'loopback HTTP URL',
    );
  });

  it('makes the signer refuse a production runtime', () => {
    expect(() => assertQaServerEnvironment({ NODE_ENV: 'production' })).toThrow(
      'refuses to run',
    );
  });
});
