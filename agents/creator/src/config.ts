import type { Hex } from 'viem';

const DEFAULT_API_URL = 'http://localhost:3001';
const DEFAULT_SEED_AMOUNT_RAW = 1_000_000n;
const DEFAULT_TRADING_WINDOW_SECONDS = 86_400n;
const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface CreatorConfig {
  apiUrl: string;
  privateKey: Hex | undefined;
  seedAmountRaw: bigint;
  tradingWindowSeconds: bigint;
  pollIntervalMs: number;
  dryRun: boolean;
}

function positiveBigInt(
  name: string,
  value: string | undefined,
  fallback: bigint,
): bigint {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (!/^\d+$/u.test(normalized) || BigInt(normalized) <= 0n) {
    throw new Error(`${name} must be a positive whole number.`);
  }
  return BigInt(normalized);
}

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

function booleanValue(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`${name} must be true/false or 1/0.`);
}

function privateKeyValue(value: string | undefined): Hex | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/u.test(normalized)) {
    throw new Error('PREDEX_PRIVATE_KEY must be a 32-byte 0x-prefixed key.');
  }
  return normalized as Hex;
}

export function loadCreatorConfig(
  environment: NodeJS.ProcessEnv = process.env,
  arguments_: readonly string[] = process.argv.slice(2),
): CreatorConfig {
  const sendRequested = arguments_.includes('--send');
  const dryRun = sendRequested
    ? false
    : booleanValue('PREDEX_DRY_RUN', environment.PREDEX_DRY_RUN, true);
  const privateKey = privateKeyValue(environment.PREDEX_PRIVATE_KEY);
  if (!dryRun && privateKey === undefined) {
    throw new Error(
      'PREDEX_PRIVATE_KEY is required only when broadcasting is explicitly enabled.',
    );
  }

  return {
    apiUrl: (environment.PREDEX_API_URL?.trim() || DEFAULT_API_URL).replace(
      /\/+$/u,
      '',
    ),
    privateKey,
    seedAmountRaw: positiveBigInt(
      'PREDEX_SEED_AMOUNT_RAW',
      environment.PREDEX_SEED_AMOUNT_RAW,
      DEFAULT_SEED_AMOUNT_RAW,
    ),
    tradingWindowSeconds: positiveBigInt(
      'PREDEX_TRADING_WINDOW_SECONDS',
      environment.PREDEX_TRADING_WINDOW_SECONDS,
      DEFAULT_TRADING_WINDOW_SECONDS,
    ),
    pollIntervalMs: positiveInteger(
      'PREDEX_POLL_INTERVAL_MS',
      environment.PREDEX_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
    ),
    dryRun,
  };
}
