export interface CandidateMarket {
  question: string;
}

export interface CandidateSource {
  readCandidates(): Promise<readonly CandidateMarket[]>;
}

/**
 * Deterministic, dependency-free demo source. It emits its candidates once,
 * then returns an empty batch on later polls so a long-running agent cannot
 * repeatedly create the same proposal.
 */
export class StaticCandidateSource implements CandidateSource {
  private emitted = false;

  constructor(private readonly candidates: readonly CandidateMarket[]) {}

  async readCandidates(): Promise<readonly CandidateMarket[]> {
    if (this.emitted) return [];
    this.emitted = true;
    return this.candidates;
  }
}

export const DEMO_CANDIDATES: readonly CandidateMarket[] = [
  {
    question: 'Will BTC close above $70,000 on August 1, 2026?',
  },
  {
    question:
      'Will the Predex creator-agent demo finish before August 1, 2026?',
  },
];
