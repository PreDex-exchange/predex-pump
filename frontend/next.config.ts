import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import path from 'node:path';

function qaWalletScriptUrl(phase: string): string {
  // This is deliberately tied to Next's development-server phase, rather than
  // NODE_ENV alone. `next build` therefore bakes in an empty URL even if a QA
  // flag is accidentally present in the production build environment.
  if (
    phase !== PHASE_DEVELOPMENT_SERVER ||
    process.env.QA_WALLET_ENABLED !== '1'
  ) {
    return '';
  }

  const rawUrl = process.env.QA_WALLET_SCRIPT_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      'QA_WALLET_SCRIPT_URL is required when QA_WALLET_ENABLED=1.',
    );
  }
  const url = new URL(rawUrl);
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error(
      'QA_WALLET_SCRIPT_URL must be an unauthenticated loopback HTTP URL.',
    );
  }
  return url.toString();
}

const createNextConfig = (phase: string): NextConfig => ({
  transpilePackages: ['@predex-pump/shared'],
  turbopack: {
    root: path.resolve(__dirname, '..'),
  },
  env: {
    PREDEX_QA_WALLET_SCRIPT_URL: qaWalletScriptUrl(phase),
  },
});

export default createNextConfig;
