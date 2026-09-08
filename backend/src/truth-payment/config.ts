import type { Address } from 'viem';

import {
  CircleTruthPaymentGate,
  DEFAULT_GATEWAY_TESTNET_URL,
} from './circle-provider.js';
import type { TruthPaymentGate } from './types.js';

export type TruthSellerMode = 'disabled' | 'circle';

export interface TruthSellerConfig {
  mode: TruthSellerMode;
  sellerAddress: Address | undefined;
  amountRaw: bigint;
  facilitatorUrl: string;
}

export type WorldAgentkitMode = 'disabled' | 'free-trial';

export type WorldAgentkitConfig =
  | { mode: 'disabled' }
  | { mode: 'free-trial'; publicApiOrigin: string };

function sellerMode(value: string | undefined): TruthSellerMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'disabled') return 'disabled';
  if (normalized === 'circle') return 'circle';
  throw new Error('PREDEX_TRUTH_SELLER_MODE must be disabled or circle.');
}

function sellerAddress(value: string | undefined): Address | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/u.test(normalized)) {
    throw new Error(
      'PREDEX_TRUTH_SELLER_ADDRESS must be a 20-byte 0x-prefixed address.',
    );
  }
  return normalized as Address;
}

function subCentAmount(value: string | undefined): bigint {
  const normalized = value?.trim() || '100';
  if (!/^\d+$/u.test(normalized)) {
    throw new Error('PREDEX_TRUTH_PRICE_RAW must be an unsigned integer.');
  }
  const amount = BigInt(normalized);
  if (amount <= 0n || amount >= 10_000n) {
    throw new Error('PREDEX_TRUTH_PRICE_RAW must be between 1 and 9999.');
  }
  return amount;
}

function worldAgentkitMode(value: string | undefined): WorldAgentkitMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'disabled') return 'disabled';
  if (normalized === 'free-trial') return 'free-trial';
  throw new Error(
    'PREDEX_WORLD_AGENTKIT_MODE must be disabled or free-trial.',
  );
}

function publicApiOrigin(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(
      'PREDEX_PUBLIC_API_ORIGIN is required when World AgentKit is enabled.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('PREDEX_PUBLIC_API_ORIGIN must be an HTTP(S) origin.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      'PREDEX_PUBLIC_API_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment.',
    );
  }
  return parsed.origin;
}

export function loadTruthSellerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TruthSellerConfig {
  const mode = sellerMode(environment.PREDEX_TRUTH_SELLER_MODE);
  const address = sellerAddress(environment.PREDEX_TRUTH_SELLER_ADDRESS);
  if (mode === 'circle' && address === undefined) {
    throw new Error(
      'PREDEX_TRUTH_SELLER_ADDRESS is required when Circle truth payments are enabled.',
    );
  }
  return {
    mode,
    sellerAddress: address,
    amountRaw: subCentAmount(environment.PREDEX_TRUTH_PRICE_RAW),
    facilitatorUrl:
      environment.PREDEX_GATEWAY_FACILITATOR_URL?.trim() ||
      DEFAULT_GATEWAY_TESTNET_URL,
  };
}

export function loadWorldAgentkitConfig(
  truthSeller: TruthSellerConfig,
  environment: NodeJS.ProcessEnv = process.env,
): WorldAgentkitConfig {
  const mode = worldAgentkitMode(environment.PREDEX_WORLD_AGENTKIT_MODE);
  if (mode === 'disabled') return { mode };
  if (truthSeller.mode !== 'circle') {
    throw new Error(
      'World AgentKit free-trial mode requires the Circle truth seller fallback.',
    );
  }
  return {
    mode,
    publicApiOrigin: publicApiOrigin(environment.PREDEX_PUBLIC_API_ORIGIN),
  };
}

export function createTruthPaymentGate(
  config: TruthSellerConfig,
): TruthPaymentGate | undefined {
  if (config.mode === 'disabled') return undefined;
  if (config.sellerAddress === undefined) {
    throw new Error('Circle truth seller address is unavailable.');
  }
  return new CircleTruthPaymentGate({
    sellerAddress: config.sellerAddress,
    amountRaw: config.amountRaw,
    facilitatorUrl: config.facilitatorUrl,
  });
}
