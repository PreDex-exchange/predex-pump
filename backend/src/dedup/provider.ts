import { FallbackMarketIntelligenceProvider } from './fallback-provider.js';
import { OpenAiMarketIntelligenceProvider } from './openai-provider.js';
import type { MarketIntelligenceProvider } from './types.js';

export interface CreateProviderOptions {
  apiKey: string | undefined;
  timeoutMs: number;
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
  });
}
