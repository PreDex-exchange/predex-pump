import type { DedupCheckResponse } from '@predex-pump/shared';

import type { CreatorLogger } from './logger.js';
import type {
  CandidateMarket,
  CandidateSource,
} from './source.js';

export interface MarketCreationInput {
  question: string;
  seedAmountRaw: bigint;
  tradingWindowSeconds: bigint;
}

export interface MarketCreationResult {
  marketId: string;
  txHash: `0x${string}`;
}

export interface MarketCreator {
  createMarket(input: MarketCreationInput): Promise<MarketCreationResult>;
}

export type DedupChecker = (
  question: string,
) => Promise<DedupCheckResponse>;

export interface CreatorAgentOptions {
  source: CandidateSource;
  dedupCheck: DedupChecker;
  marketCreator?: MarketCreator;
  logger: CreatorLogger;
  seedAmountRaw: bigint;
  tradingWindowSeconds: bigint;
  dryRun: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CreatorAgent {
  constructor(private readonly options: CreatorAgentOptions) {
    if (!options.dryRun && options.marketCreator === undefined) {
      throw new Error('A market creator is required when dry-run is disabled.');
    }
  }

  async runCycle(): Promise<void> {
    let candidates: readonly CandidateMarket[];
    try {
      candidates = await this.options.source.readCandidates();
    } catch (error) {
      this.options.logger.write({
        level: 'error',
        event: 'source-error',
        message: `source → error(${errorMessage(error)}) → continuing`,
      });
      return;
    }

    for (const candidate of candidates) {
      const question = candidate.question.trim();
      if (!question) {
        this.options.logger.write({
          level: 'warn',
          event: 'source-error',
          message: 'source → empty question → skipped → continuing',
        });
        continue;
      }

      this.options.logger.write({
        level: 'info',
        event: 'considered',
        question,
        message: 'considered',
      });

      let dedup: DedupCheckResponse;
      let dedupErrorLogged = false;
      try {
        dedup = await this.options.dedupCheck(question);
      } catch (error) {
        dedupErrorLogged = true;
        dedup = {
          available: false,
          isDuplicate: false,
          canonicalMarketId: null,
          candidates: [],
        };
        this.options.logger.write({
          level: 'warn',
          event: 'dedup-unavailable',
          question,
          message: `considered → dedup-error(${errorMessage(error)}) → fail-open`,
        });
      }

      if (!dedup.available && !dedupErrorLogged) {
        this.options.logger.write({
          level: 'warn',
          event: 'dedup-unavailable',
          question,
          message: 'considered → dedup-unavailable → fail-open',
        });
      } else if (dedup.isDuplicate) {
        const canonicalMarketId = dedup.canonicalMarketId ?? 'unknown';
        this.options.logger.write({
          level: 'info',
          event: 'duplicate',
          question,
          canonicalMarketId,
          message: `considered → duplicate(canonical=${canonicalMarketId}) → skipped`,
        });
        continue;
      }

      const creationInput: MarketCreationInput = {
        question,
        seedAmountRaw: this.options.seedAmountRaw,
        tradingWindowSeconds: this.options.tradingWindowSeconds,
      };

      if (this.options.dryRun) {
        this.options.logger.write({
          level: 'info',
          event: 'dry-run',
          question,
          message:
            `considered → new → dry-run planned(seedRaw=${creationInput.seedAmountRaw}, ` +
            `windowSeconds=${creationInput.tradingWindowSeconds}) → no broadcast`,
        });
        continue;
      }

      try {
        const result = await this.options.marketCreator?.createMarket(
          creationInput,
        );
        if (result === undefined) {
          throw new Error('Market creator was unavailable.');
        }
        this.options.logger.write({
          level: 'info',
          event: 'created',
          question,
          marketId: result.marketId,
          txHash: result.txHash,
          message:
            `considered → new → created marketId=${result.marketId} ` +
            `tx=${result.txHash}`,
        });
      } catch (error) {
        this.options.logger.write({
          level: 'error',
          event: 'create-error',
          question,
          message: `considered → new → rpc-error(${errorMessage(error)}) → continuing`,
        });
      }
    }
  }
}

export interface CreatorLoopOptions {
  pollIntervalMs: number;
  signal?: AbortSignal;
  maxCycles?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  logger: CreatorLogger;
}

function sleepUntilNextCycle(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runCreatorLoop(
  agent: CreatorAgent,
  options: CreatorLoopOptions,
): Promise<void> {
  let cycles = 0;
  const sleep = options.sleep ?? sleepUntilNextCycle;
  while (
    !options.signal?.aborted &&
    (options.maxCycles === undefined || cycles < options.maxCycles)
  ) {
    try {
      await agent.runCycle();
    } catch (error) {
      options.logger.write({
        level: 'error',
        event: 'loop-error',
        message: `loop → error(${errorMessage(error)}) → continuing`,
      });
    }
    cycles += 1;
    if (
      options.signal?.aborted ||
      (options.maxCycles !== undefined && cycles >= options.maxCycles)
    ) {
      break;
    }
    await sleep(options.pollIntervalMs, options.signal);
  }
}
