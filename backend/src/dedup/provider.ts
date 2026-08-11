import { FallbackMarketIntelligenceProvider } from './fallback-provider.js';
import { OpenAiMarketIntelligenceProvider } from './openai-provider.js';
import type { MarketIntelligenceProvider } from './types.js';

export interface CreateProviderOptions {
  apiKey: string | undefined;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export type MarketIntelligenceOperation =
  | 'embed'
  | 'extract-fields'
  | 'judge-same-fact';

/**
 * Marks an error that crossed the provider boundary. Dedup orchestration may
 * retry these calls with the deterministic provider without swallowing errors
 * from vector retrieval or from its own matching logic.
 */
export class MarketIntelligenceProviderFailure extends Error {
  readonly mode: MarketIntelligenceProvider['mode'];
  readonly operation: MarketIntelligenceOperation;

  constructor(
    provider: MarketIntelligenceProvider,
    operation: MarketIntelligenceOperation,
    cause: unknown,
  ) {
    super(`Market intelligence provider ${provider.mode} failed during ${operation}`, {
      cause,
    });
    this.name = 'MarketIntelligenceProviderFailure';
    this.mode = provider.mode;
    this.operation = operation;
  }
}

export async function callMarketIntelligenceProvider<T>(
  provider: MarketIntelligenceProvider,
  operation: MarketIntelligenceOperation,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new MarketIntelligenceProviderFailure(provider, operation, error);
  }
}

export function deterministicFallbackFor(
  provider: MarketIntelligenceProvider,
): MarketIntelligenceProvider | undefined {
  return provider.mode === 'openai'
    ? new FallbackMarketIntelligenceProvider()
    : undefined;
}

export function createMarketIntelligenceProvider(
  options: CreateProviderOptions,
): MarketIntelligenceProvider {
  if (options.apiKey === undefined || options.apiKey.trim() === '') {
    return new FallbackMarketIntelligenceProvider();
  }
  return new OpenAiMarketIntelligenceProvider({
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}
