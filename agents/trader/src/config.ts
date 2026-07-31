import type { Address } from 'viem';
import { ARC } from '@predex-pump/shared';

const DEFAULT_API_URL = 'http://localhost:3001';
const DEFAULT_RPC_URL = ARC.rpcUrls[0];

export interface TraderConfig {
  apiUrl: string;
  rpcUrl: string;
  traderAddress: Address | undefined;
  quoteSizeRaw: bigint;
  takeSizeRaw: bigint;
  quoteHalfSpreadRaw: bigint;
  takeThresholdRaw: bigint;
  repriceThresholdRaw: bigint;
  staleQuoteSeconds: number;
  pollIntervalMs: number;
  maxInventoryPerSideRaw: bigint;
  maxNotionalPerOrderRaw: bigint;
  maxOrdersInFlight: number;
  maxSessionSpendRaw: bigint;
  truthMode: 'auto' | 'free' | 'paid' | 'skip';
  truthMaxPaymentRaw: bigint;
  dryRun: boolean;
}

function truthMode(
  value: string | undefined,
): TraderConfig['truthMode'] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'auto';
  if (
    normalized === 'auto' ||
    normalized === 'free' ||
    normalized === 'paid' ||
    normalized === 'skip'
  ) {
    return normalized;
  }
  throw new Error('PREDEX_TRUTH_MODE must be auto, free, paid, or skip.');
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

function nonNegativeBigInt(
  name: string,
  value: string | undefined,
  fallback: bigint,
): bigint {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${name} must be a non-negative whole number.`);
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

function addressValue(value: string | undefined): Address | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/u.test(normalized)) {
    throw new Error('PREDEX_TRADER_ADDRESS must be a 20-byte 0x-prefixed address.');
  }
  return normalized.toLowerCase() as Address;
}

export function loadTraderConfig(
  environment: NodeJS.ProcessEnv = process.env,
  arguments_: readonly string[] = process.argv.slice(2),
): TraderConfig {
  const dryRun = arguments_.includes('--send')
    ? false
    : booleanValue('PREDEX_DRY_RUN', environment.PREDEX_DRY_RUN, true);

  // PREDEX_PRIVATE_KEY is deliberately not accessed here. The CLI reads it
  // only after this explicit send gate has selected broadcast mode.
  return {
    apiUrl: (environment.PREDEX_API_URL?.trim() || DEFAULT_API_URL).replace(
      /\/+$/u,
      '',
    ),
    rpcUrl: environment.PREDEX_RPC_URL?.trim() || DEFAULT_RPC_URL,
    traderAddress: addressValue(environment.PREDEX_TRADER_ADDRESS),
    quoteSizeRaw: positiveBigInt(
      'PREDEX_QUOTE_SIZE_RAW',
      environment.PREDEX_QUOTE_SIZE_RAW,
      250_000n,
    ),
    takeSizeRaw: positiveBigInt(
      'PREDEX_TAKE_SIZE_RAW',
      environment.PREDEX_TAKE_SIZE_RAW,
      250_000n,
    ),
    quoteHalfSpreadRaw: nonNegativeBigInt(
      'PREDEX_QUOTE_HALF_SPREAD_RAW',
      environment.PREDEX_QUOTE_HALF_SPREAD_RAW,
      20_000n,
    ),
    takeThresholdRaw: nonNegativeBigInt(
      'PREDEX_TAKE_THRESHOLD_RAW',
      environment.PREDEX_TAKE_THRESHOLD_RAW,
      30_000n,
    ),
    repriceThresholdRaw: nonNegativeBigInt(
      'PREDEX_REPRICE_THRESHOLD_RAW',
      environment.PREDEX_REPRICE_THRESHOLD_RAW,
      10_000n,
    ),
    staleQuoteSeconds: positiveInteger(
      'PREDEX_STALE_QUOTE_SECONDS',
      environment.PREDEX_STALE_QUOTE_SECONDS,
      90,
    ),
    pollIntervalMs: positiveInteger(
      'PREDEX_POLL_INTERVAL_MS',
      environment.PREDEX_POLL_INTERVAL_MS,
      15_000,
    ),
    maxInventoryPerSideRaw: positiveBigInt(
      'PREDEX_MAX_INVENTORY_PER_SIDE_RAW',
      environment.PREDEX_MAX_INVENTORY_PER_SIDE_RAW,
      2_000_000n,
    ),
    maxNotionalPerOrderRaw: positiveBigInt(
      'PREDEX_MAX_NOTIONAL_PER_ORDER_RAW',
      environment.PREDEX_MAX_NOTIONAL_PER_ORDER_RAW,
      500_000n,
    ),
    maxOrdersInFlight: positiveInteger(
      'PREDEX_MAX_ORDERS_IN_FLIGHT',
      environment.PREDEX_MAX_ORDERS_IN_FLIGHT,
      4,
    ),
    maxSessionSpendRaw: positiveBigInt(
      'PREDEX_MAX_SESSION_SPEND_RAW',
      environment.PREDEX_MAX_SESSION_SPEND_RAW,
      2_000_000n,
    ),
    truthMode: truthMode(environment.PREDEX_TRUTH_MODE),
    truthMaxPaymentRaw: positiveBigInt(
      'PREDEX_TRUTH_MAX_PAYMENT_RAW',
      environment.PREDEX_TRUTH_MAX_PAYMENT_RAW,
      100n,
    ),
    dryRun,
  };
}
