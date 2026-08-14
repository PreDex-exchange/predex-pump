import { ARC } from '@predex-pump/shared';

const DEFAULT_WEB_ORIGIN = 'http://localhost:3000';

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`);
  }
  return parsed;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false, received ${value}`);
}

export interface AccountLayerConfig {
  webOrigin: string;
  siweDomain: string;
  siweUri: string;
  siweStatement: string;
  chainId: number;
  nonceTtlMs: number;
  sessionTtlMs: number;
  secureCookies: boolean;
  cookiePath: string;
  rpcUrl: string;
}

// When the API is mounted behind a shared hostname under a path prefix, the
// session cookie must declare that prefix. A reverse proxy strips the prefix
// before the backend sees it, so the value cannot be derived from the request
// — the browser scopes the cookie by the URL it asked for, not by what we
// received. Left at '/' the cookie is attached to every request to the shared
// host, including other tenants' routes.
function resolveCookiePath(value: string | undefined): string {
  const path = value?.trim();
  if (!path) return '/';
  if (!path.startsWith('/')) {
    throw new Error(`ACCOUNT_COOKIE_PATH must start with "/", received ${path}`);
  }
  // Strip a trailing slash so '/pump/' and '/pump' scope identically; '/' stays.
  return path.length > 1 ? path.replace(/\/+$/u, '') : path;
}

export function loadAccountLayerConfig(): AccountLayerConfig {
  const webOrigin = (process.env.PREDEX_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN).replace(
    /\/+$/u,
    '',
  );
  const webUrl = new URL(webOrigin);
  const siweDomain = process.env.SIWE_DOMAIN?.trim() || webUrl.host;
  const siweUri = process.env.SIWE_URI?.trim() || webOrigin;

  return {
    webOrigin,
    siweDomain,
    siweUri,
    siweStatement:
      'Sign in to predex.fun to save your profile, watchlist, and recent activity. Trading stays wallet-only.',
    chainId: ARC.chainId,
    nonceTtlMs: positiveInteger('SIWE_NONCE_TTL_SECONDS', 5 * 60) * 1_000,
    sessionTtlMs:
      positiveInteger('ACCOUNT_SESSION_TTL_SECONDS', 7 * 24 * 60 * 60) * 1_000,
    secureCookies: booleanValue(
      'ACCOUNT_COOKIE_SECURE',
      webUrl.protocol === 'https:',
    ),
    cookiePath: resolveCookiePath(process.env.ACCOUNT_COOKIE_PATH),
    rpcUrl: process.env.ARC_RPC_URL?.trim() || ARC.rpcUrls[0],
  };
}
