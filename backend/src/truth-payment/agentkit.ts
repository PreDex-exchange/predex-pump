import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';
import { ARC } from '@predex-pump/shared';
import type {
  PaymentRequired,
  PaymentRequiredContext,
  PaymentRequirements,
  ResourceInfo,
} from '@x402/core/types';
import {
  AGENTKIT,
  agentkitResourceServerExtension,
  createAgentBookVerifier,
  declareAgentkitExtension,
  parseAgentkitHeader,
  validateAgentkitMessage,
  verifyAgentkitSignature,
  type AgentBookVerifier,
  type AgentkitPayload,
  type AgentkitSignatureVerificationConfig,
  type AgentkitVerifyResult,
} from '@worldcoin/agentkit';

import type {
  TruthAgentTrialGate,
  TruthPaymentRequired,
} from './types.js';

export const WORLD_AGENTKIT_FREE_USES = 3;
export const WORLD_AGENTKIT_TRIAL_SCOPE = 'GET /truth/:marketId';
const ARC_TESTNET_NETWORK = `eip155:${ARC.chainId}`;
const CHALLENGE_EXPIRATION_SECONDS = 300;
const EXTERNAL_VERIFICATION_TIMEOUT_MS = 5_000;
const MAX_TRANSACTION_ATTEMPTS = 5;
const STATEMENT =
  'Verify this Continuity trading agent is backed by a unique human';

export interface WorldAgentkitLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

const DEFAULT_LOGGER: WorldAgentkitLogger = {
  info(fields, message) {
    console.info(`[world-agentkit] ${message}`, fields);
  },
  warn(fields, message) {
    console.warn(`[world-agentkit] ${message}`, fields);
  },
};

function opaqueKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function retryableTransactionError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2034')
  );
}

async function withinDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('World AgentKit dependency timed out.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export interface AgentkitTrialClaim {
  scope: string;
  humanId: string;
  nonce: string;
  limit: number;
}

export interface AgentkitTrialStore {
  hasUsedNonce(nonce: string): Promise<boolean>;
  tryGrant(claim: AgentkitTrialClaim): Promise<boolean>;
}

/** Postgres is authoritative; Redis is intentionally absent from this path. */
export class PrismaAgentkitTrialStore implements AgentkitTrialStore {
  constructor(private readonly prisma: PrismaClient) {}

  async hasUsedNonce(nonce: string): Promise<boolean> {
    const record = await this.prisma.agentkitTrialNonce.findUnique({
      where: { nonceKey: opaqueKey(nonce) },
      select: { nonceKey: true },
    });
    return record !== null;
  }

  async tryGrant({
    scope,
    humanId,
    nonce,
    limit,
  }: AgentkitTrialClaim): Promise<boolean> {
    if (
      scope === '' ||
      humanId === '' ||
      nonce === '' ||
      !Number.isSafeInteger(limit) ||
      limit <= 0
    ) {
      throw new Error('World AgentKit trial claim is invalid.');
    }
    const humanKey = opaqueKey(humanId);
    const nonceKey = opaqueKey(nonce);

    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const priorNonce = await transaction.agentkitTrialNonce.findUnique({
              where: { nonceKey },
              select: { nonceKey: true },
            });
            if (priorNonce !== null) return false;

            const priorUsage = await transaction.agentkitTrialUsage.findUnique({
              where: { scope_humanKey: { scope, humanKey } },
              select: { uses: true },
            });
            if ((priorUsage?.uses ?? 0) >= limit) return false;

            if (priorUsage === null) {
              await transaction.agentkitTrialUsage.create({
                data: { scope, humanKey, uses: 1 },
              });
            } else {
              await transaction.agentkitTrialUsage.update({
                where: { scope_humanKey: { scope, humanKey } },
                data: { uses: { increment: 1 } },
              });
            }
            await transaction.agentkitTrialNonce.create({
              data: { nonceKey, scope, humanKey },
            });
            return true;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 1_000,
            timeout: 3_000,
          },
        );
      } catch (error) {
        if (
          retryableTransactionError(error) &&
          attempt < MAX_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        if (retryableTransactionError(error)) return false;
        throw error;
      }
    }
    return false;
  }
}

export interface WorldAgentkitTruthTrialGateOptions {
  prisma: PrismaClient;
  publicApiOrigin: string;
  rpcUrl: string;
  agentBook?: AgentBookVerifier;
  store?: AgentkitTrialStore;
  logger?: WorldAgentkitLogger;
  externalTimeoutMs?: number;
  verifySignature?: (
    payload: AgentkitPayload,
    options?: AgentkitSignatureVerificationConfig,
  ) => Promise<AgentkitVerifyResult>;
}

export class WorldAgentkitTruthTrialGate implements TruthAgentTrialGate {
  readonly #agentBook: AgentBookVerifier;
  readonly #logger: WorldAgentkitLogger;
  readonly #origin: string;
  readonly #rpcUrl: string;
  readonly #store: AgentkitTrialStore;
  readonly #externalTimeoutMs: number;
  readonly #verifySignature: NonNullable<
    WorldAgentkitTruthTrialGateOptions['verifySignature']
  >;

  constructor(options: WorldAgentkitTruthTrialGateOptions) {
    this.#origin = options.publicApiOrigin.replace(/\/+$/u, '');
    this.#rpcUrl = options.rpcUrl;
    this.#externalTimeoutMs =
      options.externalTimeoutMs ?? EXTERNAL_VERIFICATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#externalTimeoutMs) ||
      this.#externalTimeoutMs <= 0 ||
      this.#externalTimeoutMs > EXTERNAL_VERIFICATION_TIMEOUT_MS
    ) {
      throw new Error('World AgentKit timeout must be between 1 and 5000 ms.');
    }
    this.#agentBook = options.agentBook ?? createAgentBookVerifier();
    this.#store = options.store ?? new PrismaAgentkitTrialStore(options.prisma);
    this.#logger = options.logger ?? DEFAULT_LOGGER;
    this.#verifySignature = options.verifySignature ?? verifyAgentkitSignature;
  }

  async paymentRequiredExtensions(
    resourcePath: string,
    paymentRequired: TruthPaymentRequired,
  ): Promise<Record<string, unknown>> {
    const resourceUri = this.resourceUri(resourcePath);
    const declaration = declareAgentkitExtension({
      domain: new URL(resourceUri).hostname,
      resourceUri,
      network: paymentRequired.accepts.map(({ network }) => network),
      statement: STATEMENT,
      expirationSeconds: CHALLENGE_EXPIRATION_SECONDS,
      mode: { type: 'free-trial', uses: WORLD_AGENTKIT_FREE_USES },
    })[AGENTKIT];
    const enrich =
      agentkitResourceServerExtension.enrichPaymentRequiredResponse;
    if (declaration === undefined || enrich === undefined) {
      throw new Error('World AgentKit challenge enrichment is unavailable.');
    }
    const resourceInfo: ResourceInfo = {
      ...paymentRequired.resource,
      url: resourceUri,
    };
    const requirements = paymentRequired.accepts as unknown as PaymentRequirements[];
    const paymentRequiredResponse = {
      ...paymentRequired,
      resource: resourceInfo,
      accepts: requirements,
      extensions: {},
    } as PaymentRequired;
    const context: PaymentRequiredContext = {
      requirements,
      resourceInfo,
      paymentRequiredResponse,
    };
    return { [AGENTKIT]: await enrich(declaration, context) };
  }

  async authorize(header: string, resourcePath: string): Promise<boolean> {
    const resourceUri = this.resourceUri(resourcePath);
    try {
      const payload = parseAgentkitHeader(header);
      if (
        payload.chainId !== ARC_TESTNET_NETWORK ||
        (payload.type !== 'eip191' && payload.type !== 'eip1271') ||
        payload.version !== '1' ||
        payload.statement !== STATEMENT ||
        payload.uri !== resourceUri ||
        payload.resources?.includes(resourceUri) !== true
      ) {
        this.#logger.warn(
          { outcome: 'invalid' },
          'AgentKit request did not match the truth-resource challenge',
        );
        return false;
      }
      const validation = await validateAgentkitMessage(payload, resourceUri, {
        checkNonce: async (nonce) => !(await this.#store.hasUsedNonce(nonce)),
      });
      if (!validation.valid) {
        this.#logger.warn(
          { outcome: 'invalid' },
          'AgentKit request validation failed',
        );
        return false;
      }
      const identity = await withinDeadline(
        (async () => {
          const verification = await this.#verifySignature(payload, {
            rpcUrls: { [ARC_TESTNET_NETWORK]: this.#rpcUrl },
          });
          if (!verification.valid || verification.address === undefined) {
            return { verification, humanId: null };
          }
          return {
            verification,
            humanId: await this.#agentBook.lookupHuman(verification.address),
          };
        })(),
        this.#externalTimeoutMs,
      );
      const { verification, humanId } = identity;
      if (!verification.valid || verification.address === undefined) {
        this.#logger.warn(
          { outcome: 'invalid' },
          'AgentKit request signature failed',
        );
        return false;
      }
      if (!humanId) {
        this.#logger.info(
          { outcome: 'unverified', agent: verification.address },
          'AgentKit human backing was not verified in AgentBook',
        );
        return false;
      }
      const granted = await this.#store.tryGrant({
        scope: WORLD_AGENTKIT_TRIAL_SCOPE,
        humanId,
        nonce: payload.nonce,
        limit: WORLD_AGENTKIT_FREE_USES,
      });
      this.#logger.info(
        {
          outcome: granted ? 'granted' : 'exhausted-or-replayed',
          agent: verification.address,
        },
        granted
          ? 'AgentKit human-backed truth trial granted'
          : 'AgentKit human-backed truth trial requires Circle payment',
      );
      return granted;
    } catch {
      this.#logger.warn(
        { outcome: 'unavailable' },
        'AgentKit verification unavailable; preserving Circle payment',
      );
      return false;
    }
  }

  private resourceUri(resourcePath: string): string {
    if (!resourcePath.startsWith('/') || resourcePath.startsWith('//')) {
      throw new Error('World AgentKit resource path must be origin-relative.');
    }
    return `${this.#origin}${resourcePath}`;
  }
}
