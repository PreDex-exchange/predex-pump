export class AgentSdkStubError extends Error {
  constructor(surface: string) {
    super(`${surface} is a typed D1 scaffold; its implementation lands later.`);
    this.name = 'AgentSdkStubError';
  }
}

export interface DedupCandidate {
  marketId: string;
  question: string;
  similarity: number;
}

export interface DedupCheckResult {
  duplicate: boolean;
  candidates: readonly DedupCandidate[];
}

export type DedupCheck = (question: string) => Promise<DedupCheckResult>;

export const dedupCheck: DedupCheck = async (_question) => {
  throw new AgentSdkStubError('dedupCheck(question)');
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
