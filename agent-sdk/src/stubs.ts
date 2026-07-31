import type { DedupCheckResponse } from '@predex-pump/shared/rest';

import {
  createRestClient,
  type PredexRestClient,
} from './rest.js';

export class AgentSdkStubError extends Error {
  constructor(surface: string) {
    super(`${surface} is a typed D1 scaffold; its implementation lands later.`);
    this.name = 'AgentSdkStubError';
  }
}

export type {
  DedupCandidate,
  DedupCheckRequest,
  DedupCheckResponse,
} from '@predex-pump/shared';

export type DedupCheck = (
  question: string,
  restClient?: Pick<PredexRestClient, 'dedupCheck'>,
) => Promise<DedupCheckResponse>;

export const dedupCheck: DedupCheck = async (
  question,
  restClient = createRestClient(),
) => {
  try {
    return await restClient.dedupCheck({ question });
  } catch {
    // Keep custom REST-client implementations fail-open too.
    return {
      available: false,
      isDuplicate: false,
      canonicalMarketId: null,
      candidates: [],
    };
  }
};

export interface X402PaymentLimit {
  asset: string;
  maxAmountRaw: bigint;
  network?: string;
}

export interface TruthBuyInput {
  question: string;
  payment: X402PaymentLimit;
}

export interface TruthBuyResult {
  answer: string;
  sourceUrl: string;
  paymentReceipt: unknown;
}

export interface TruthClient {
  buy(input: TruthBuyInput): Promise<TruthBuyResult>;
}

export const truth: TruthClient = {
  async buy(_input) {
    throw new AgentSdkStubError('truth.buy(...) (x402)');
  },
};
