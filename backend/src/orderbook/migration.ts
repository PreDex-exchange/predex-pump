import { randomUUID } from 'node:crypto';

import {
  Prisma,
  type BookMigration,
  type Market,
  type PrismaClient,
  type SignedOrder,
} from '@prisma/client';
import {
  ADDRESSES,
  ALLOWED_MINIMUM_TICK_SIZES_RAW,
  ORDER_PRICE_SCALE_RAW,
  assertAllowedMinimumTickSizeRaw,
  floorOrderSizeToGranularity,
  quantizePriceRaw,
} from '@predex-pump/shared';
import {
  CTF_EXCHANGE_PRICE_SCALE,
  Side,
  buildCtfExchangeApprovalForAllTx,
  buildCtfExchangeOrder,
  buildCtfExchangeRegisterTokenTx,
  buildMiniClobCutoverTx,
  ctfExchangeOrderTerms,
  generateOrderSalt,
  hashCtfExchangeOrder,
  signCtfExchangeOrder,
} from '@predex-pump/shared/tx';
import {
  isAddressEqual,
  zeroHash,
  type Hex,
  type LocalAccount,
} from 'viem';

import type {
  BookMigrationChainReader,
  BookMigrationChainState,
  FreshOrderChainState,
  MiniClobSeedOrderState,
  OrderChainReader,
} from './chain-reader.js';
import {
  operatorFailure,
  type OperatorLogger,
  type OperatorTransactionSubmitter,
} from './operator.js';
import { signedOrderCreateData, signedOrderFromRow } from './order.js';
import { preflightSignedOrder } from './preflight.js';
import { persistOrderValidationSnapshot } from './service.js';

const CLAIM_LEASE_SECONDS = 120;
const REGISTRATION_UNKNOWN_RECHECK_MS = 60_000;
const CUTOVER_UNKNOWN_RECHECK_MS = 60_000;
const MAX_MIGRATION_PRICE_DEVIATION_RAW =
  ALLOWED_MINIMUM_TICK_SIZES_RAW.at(-1)! - 1n;

/**
 * Durable state machine (all replacement rows remain status=STAGED until the
 * final database transaction):
 *
 *   DISCOVERED ──> CANCEL_SUBMITTING ──> CANCEL_SUBMITTED
 *                         │                    │ confirmed stale
 *                         │ unknown            v
 *                         └──> quarantine   CANCELLED
 *                                      │ stable post-cutover snapshot/sign
 *                                      v
 *                                   STAGED
 *       STAGED ──approval needed──> APPROVAL_SUBMITTING
 *          │                            │ send returned hash
 *          │                            v
 *          │                     APPROVAL_SUBMITTED
 *          │                            │ confirmed
 *          └─approval present───────────┴──> registration
 *       registration confirmed ──> PUBLISHING ──> MIGRATED
 *
 * A no-hash cutover outcome is quarantined until conditionStale is observable;
 * it is never blindly resubmitted. Registration is the Hybrid activation gate,
 * so it is never submitted before the old venue is confirmed stale.
 * Any in-flight state is restartable; MIGRATED and FAILED are terminal.
 */

export type MigrationIterationResult =
  | { outcome: 'IDLE' | 'SKIPPED' | 'PROGRESSED'; marketId?: string }
  | {
      outcome: 'FAILED';
      marketId: string;
      retryAfterMs: number;
      failureCode: string;
    };

type ClaimedMigration = BookMigration & { market: Market };
type Outcome = 'YES' | 'NO';

class MigrationInvariantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

class RegistrationCheckpointError extends Error {
  constructor(cause: unknown) {
    super('Registration was submitted but its transaction hash was not checkpointed', {
      cause,
    });
  }
}

class CutoverCheckpointError extends Error {
  constructor(cause: unknown) {
    super('Cutover was submitted but its transaction hash was not checkpointed', {
      cause,
    });
  }
}

function unixNow(): number {
  return Math.floor(Date.now() / 1_000);
}

function remaining(order: MiniClobSeedOrderState): bigint {
  const value = order.sizeRaw - order.filledRaw;
  if (value < 0n) {
    throw new MigrationInvariantError(
      'SEED_OVERFILLED',
      `Seed order ${order.orderId} is filled beyond its size`,
    );
  }
  return value;
}

function cancelStatus(order: MiniClobSeedOrderState): string {
  if (remaining(order) === 0n) return 'FILLED';
  return order.open ? 'PENDING' : 'CONFIRMED';
}

function stateOrder(
  state: BookMigrationChainState,
  outcome: Outcome,
): MiniClobSeedOrderState {
  const order = outcome === 'YES' ? state.yesOrder : state.noOrder;
  if (order === null) {
    throw new MigrationInvariantError(
      'INVALID_SEED',
      'Zero-handoff migration has no seed order',
    );
  }
  return order;
}

function zeroHandoff(state: BookMigrationChainState): boolean {
  return state.yesOrder === null && state.noOrder === null;
}

function hasReplacements(migration: BookMigration): boolean {
  return (
    migration.yesReplacementOrderHash !== null ||
    migration.noReplacementOrderHash !== null
  );
}

type RegistrationDisposition = 'REGISTERED' | 'ABSENT' | 'MISMATCHED';

function isRegistrationFailure(code: string): boolean {
  return (
    code === 'TOKEN_NOT_REGISTERED' ||
    code === 'TOKEN_REGISTRATION_MISMATCH' ||
    code === 'REGISTRATION_UNAUTHORIZED' ||
    code === 'REGISTRATION_REVERTED' ||
    code === 'REGISTRATION_NOT_APPLIED' ||
    code.startsWith('REGISTRATION_SUBMIT_')
  );
}

function safeMessage(code: string): string {
  const messages: Record<string, string> = {
    APPROVAL_REVERTED: 'CTFExchange token approval transaction reverted',
    CUTOVER_REVERTED: 'MiniCLOB cutover transaction reverted',
    CUTOVER_NOT_APPLIED: 'Confirmed MiniCLOB cutover left the condition active',
    INVALID_SEED: 'MiniCLOB seed state does not match the graduated market',
    CONDITION_NOT_PREPARED: 'Conditional Tokens condition is not prepared',
    EXCHANGE_IMMUTABLE_MISMATCH: 'CTFExchange immutable bindings do not match the configured deployment',
    INVALID_TICK_SIZE: 'Market minimum tick size is outside the supported policy',
    MARKET_RESOLVED: 'Market resolved before its book migration completed',
    MISSING_RECOVERED_BALANCE: 'Recovered position-token balance is below the staged order size',
    MIGRATION_PRICE_OUT_OF_RANGE: 'Tick quantization moved a replacement price outside the supported range',
    MIGRATION_PRICE_DEVIATION: 'Tick quantization exceeded the bounded migration tolerance',
    UNREPRESENTABLE_PRICE: 'Quantized replacement price was not exactly representable',
    REGISTRATION_NOT_APPLIED: 'Confirmed CTFExchange registration did not register the token pair',
    REGISTRATION_REVERTED: 'CTFExchange token registration transaction reverted',
    REGISTRATION_UNAUTHORIZED: 'Operator is not authorized to register CTFExchange tokens',
    REGISTRY_BINDING_MISMATCH: 'Fresh registry token binding conflicts with the indexed market',
    REGISTRY_LIFECYCLE_MISMATCH: 'Fresh registry lifecycle is not the expected graduated market',
    TOKEN_REGISTRATION_MISMATCH: 'CTFExchange token registration is partial or conflicts with the market',
    TOKEN_NOT_REGISTERED: 'CTFExchange token pair is not activated',
    MINICLOB_NOT_STALE: 'MiniCLOB cutover is not authoritative on-chain',
    WRONG_NONCE: 'Operator nonce changed before migration publication',
  };
  return messages[code] ?? 'Book migration failed an invariant check';
}

export class BookMigrationOperator {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly chainReader: BookMigrationChainReader & OrderChainReader,
    private readonly submitter: OperatorTransactionSubmitter,
    private readonly account: LocalAccount,
    private readonly logger: OperatorLogger,
    private readonly now: () => number = unixNow,
    private readonly claimLeaseSeconds = CLAIM_LEASE_SECONDS,
    private readonly registrationEnabled = false,
  ) {}

  async processOnce(): Promise<MigrationIterationResult> {
    const now = this.now();
    await this.detectOne(now);
    const migration = await this.claimOne(now);
    if (migration === null) return { outcome: 'IDLE' };

    try {
      switch (migration.status) {
        case 'DISCOVERED':
        case 'STAGING':
        case 'CANCELLING':
          return await this.prepareOrSubmitCutover(migration);
        case 'CANCEL_SUBMITTING':
        case 'CANCEL_SUBMISSION_UNKNOWN':
          return await this.reconcileUnknownCutover(migration);
        case 'CANCEL_SUBMITTED':
          return await this.confirmCutover(migration);
        case 'CANCELLED':
          return await this.stageFromFreshSnapshot(migration);
        case 'REGISTRATION_SUBMITTING':
        case 'REGISTRATION_SUBMISSION_UNKNOWN':
          return await this.reconcileUnknownRegistration(migration);
        case 'REGISTRATION_SUBMITTED':
          return await this.confirmRegistration(migration);
        case 'STAGED':
          return await this.prepareApprovalOrRegistration(migration);
        case 'APPROVAL_SUBMITTING':
        case 'APPROVAL_SUBMISSION_UNKNOWN':
          return await this.reconcileUnknownApproval(migration);
        case 'APPROVAL_SUBMITTED':
          return await this.confirmApproval(migration);
        case 'PUBLISHING':
          return await this.publish(migration);
        default:
          return await this.failTerminal(
            migration,
            'UNKNOWN_MIGRATION_STATE',
            'Book migration entered an unknown state',
          );
      }
    } catch (error) {
      if (error instanceof MigrationInvariantError) {
        return this.failTerminal(
          migration,
          error.code,
          safeMessage(error.code),
          isRegistrationFailure(error.code)
            ? { registrationStatus: 'FAILED' }
            : {},
        );
      }
      if (error instanceof RegistrationCheckpointError) {
        // REGISTRATION_SUBMITTING was persisted before broadcast. Keep that
        // ambiguity state intact so the next lease holder re-reads both
        // mappings instead of treating a database checkpoint failure as a
        // terminal contract failure.
        return this.retry(migration, 'REGISTRATION_CHECKPOINT_PENDING', 1_000);
      }
      if (error instanceof CutoverCheckpointError) {
        // CANCEL_SUBMITTING was persisted before broadcast. Without a durable
        // hash, only the monotonic conditionStale flag may clear ambiguity.
        return this.cutoverSubmissionUnknown(
          migration,
          'CUTOVER_CHECKPOINT_PENDING',
          1_000,
        );
      }
      const failure = operatorFailure(error, migration.attemptCount + 1);
      if (failure.code.startsWith('RPC_')) {
        return this.retry(migration, `READ_${failure.code}`, failure.retryAfterMs);
      }
      return this.failTerminal(
        migration,
        'MIGRATION_FAILED',
        'Book migration failed before an on-chain submission',
      );
    }
  }

  private async detectOne(now: number): Promise<void> {
    const market = await this.prisma.market.findFirst({
      where: {
        phase: 'Graduated',
        bookMigration: null,
        yesSeedOrderId: { not: null },
        noSeedOrderId: { not: null },
        yesTokenId: { not: null },
        noTokenId: { not: null },
        resolution: { is: null },
      },
      orderBy: [{ graduatedAt: 'asc' }, { id: 'asc' }],
    });
    if (
      market === null ||
      market.yesSeedOrderId === null ||
      market.noSeedOrderId === null
    ) {
      return;
    }
    try {
      await this.prisma.bookMigration.create({
        data: {
          marketId: market.id,
          yesSeedOrderId: market.yesSeedOrderId,
          noSeedOrderId: market.noSeedOrderId,
          createdAt: now,
          updatedAt: now,
        },
      });
      this.logger.info(`[migration] market=${market.id} detected`);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return;
      }
      throw error;
    }
  }

  private async claimOne(now: number): Promise<ClaimedMigration | null> {
    const candidates = await this.prisma.bookMigration.findMany({
      where: {
        status: { notIn: ['MIGRATED', 'FAILED'] },
        nextAttemptAt: { lte: now },
        OR: [{ claimToken: null }, { claimExpiresAt: { lte: now } }],
      },
      include: { market: true },
      orderBy: [{ createdAt: 'asc' }, { marketId: 'asc' }],
      take: 4,
    });
    for (const candidate of candidates) {
      const claimToken = randomUUID();
      const claimed = await this.prisma.bookMigration.updateMany({
        where: {
          marketId: candidate.marketId,
          status: candidate.status,
          nextAttemptAt: { lte: now },
          OR: [{ claimToken: null }, { claimExpiresAt: { lte: now } }],
        },
        data: {
          claimToken,
          claimExpiresAt: now + this.claimLeaseSeconds,
          updatedAt: now,
        },
      });
      if (claimed.count === 1) {
        return { ...candidate, claimToken, claimExpiresAt: now + this.claimLeaseSeconds };
      }
    }
    return null;
  }

  private stateInput(migration: ClaimedMigration) {
    const market = migration.market;
    if (market.yesTokenId === null || market.noTokenId === null) {
      throw new MigrationInvariantError('INVALID_SEED', 'Market token binding is missing');
    }
    return {
      marketId: BigInt(market.id),
      maker: this.account.address as Hex,
      conditionId: market.conditionId as Hex,
      yesTokenId: BigInt(market.yesTokenId),
      noTokenId: BigInt(market.noTokenId),
      yesSeedOrderId: BigInt(migration.yesSeedOrderId),
      noSeedOrderId: BigInt(migration.noSeedOrderId),
    };
  }

  private async readState(
    migration: ClaimedMigration,
  ): Promise<BookMigrationChainState> {
    const state = await this.chainReader.readBookMigrationState(
      this.stateInput(migration),
    );
    this.validateSeedState(migration, state);
    return state;
  }

  private validateSeedState(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
  ): void {
    const market = migration.market;
    if (state.payoutDenominator !== 0n) {
      throw new MigrationInvariantError('MARKET_RESOLVED', 'Market is resolved');
    }
    if (!state.conditionPrepared) {
      throw new MigrationInvariantError(
        'CONDITION_NOT_PREPARED',
        'Conditional Tokens condition is not prepared',
      );
    }
    if (market.yesTokenId === null || market.noTokenId === null) {
      throw new MigrationInvariantError('INVALID_SEED', 'Market token binding is missing');
    }
    if (state.registryLifecycle.state >= 4) {
      throw new MigrationInvariantError(
        'MARKET_RESOLVED',
        'Registry reports a resolved market',
      );
    }
    if (
      state.registryLifecycle.state !== 3 ||
      state.registryLifecycle.paused ||
      !isAddressEqual(
        state.registryLifecycle.creator,
        market.creator as Hex,
      ) ||
      state.registryLifecycle.marketTypeVersion !== market.marketTypeVersion
    ) {
      throw new MigrationInvariantError(
        'REGISTRY_LIFECYCLE_MISMATCH',
        'Registry lifecycle does not match the graduated market',
      );
    }
    if (state.registryTradingEndsAt !== BigInt(market.tradingEndsAt)) {
      throw new MigrationInvariantError(
        'REGISTRY_BINDING_MISMATCH',
        'Registry trading deadline does not match the indexed market',
      );
    }
    if (
      !isAddressEqual(state.registryBinding.collateralAddress, ADDRESSES.usdc) ||
      !isAddressEqual(state.registryBinding.ctfAddress, ADDRESSES.ctf) ||
      !isAddressEqual(state.registryBinding.oracleAddress, ADDRESSES.oracle) ||
      state.registryBinding.questionId.toLowerCase() !==
        market.questionId.toLowerCase() ||
      state.registryBinding.conditionId.toLowerCase() !==
        market.conditionId.toLowerCase() ||
      state.registryBinding.yesTokenId !== BigInt(market.yesTokenId) ||
      state.registryBinding.noTokenId !== BigInt(market.noTokenId)
    ) {
      throw new MigrationInvariantError(
        'REGISTRY_BINDING_MISMATCH',
        'Registry token binding does not match the indexed market',
      );
    }
    if (
      !isAddressEqual(state.exchangeCtfAddress, ADDRESSES.ctf) ||
      !isAddressEqual(state.exchangeCollateralAddress, ADDRESSES.usdc)
    ) {
      throw new MigrationInvariantError(
        'EXCHANGE_IMMUTABLE_MISMATCH',
        'CTFExchange immutable bindings do not match the deployment',
      );
    }
    const yesSeedOrderId = BigInt(migration.yesSeedOrderId);
    const noSeedOrderId = BigInt(migration.noSeedOrderId);
    if (
      state.graduationSeedOrderIds.yesOrderId !== yesSeedOrderId ||
      state.graduationSeedOrderIds.noOrderId !== noSeedOrderId
    ) {
      throw new MigrationInvariantError(
        'INVALID_SEED',
        'Indexed seed ids do not match MiniCLOB graduation state',
      );
    }
    const indexedZeroHandoff = yesSeedOrderId === 0n && noSeedOrderId === 0n;
    if (
      !indexedZeroHandoff &&
      (yesSeedOrderId === 0n || noSeedOrderId === 0n)
    ) {
      throw new MigrationInvariantError(
        'INVALID_SEED',
        'Only a 0/0 pair may represent a zero-liquidity handoff',
      );
    }
    if (indexedZeroHandoff) {
      if (!zeroHandoff(state) || !state.conditionStale) {
        throw new MigrationInvariantError(
          'MINICLOB_NOT_STALE',
          'Zero-handoff condition is not stale on MiniCLOB',
        );
      }
      return;
    }
    if (state.yesOrder === null || state.noOrder === null) {
      throw new MigrationInvariantError('INVALID_SEED', 'Seed orders are missing');
    }
    const expected = [
      [state.yesOrder, BigInt(market.yesTokenId)],
      [state.noOrder, BigInt(market.noTokenId)],
    ] as const;
    for (const [order, tokenId] of expected) {
      if (
        !isAddressEqual(order.maker, this.account.address) ||
        order.conditionId.toLowerCase() !== market.conditionId.toLowerCase() ||
        order.tokenId !== tokenId ||
        order.side !== Side.SELL ||
        order.sizeRaw <= 0n ||
        order.priceRaw <= 0n ||
        order.priceRaw > CTF_EXCHANGE_PRICE_SCALE
      ) {
        throw new MigrationInvariantError('INVALID_SEED', 'Seed identity mismatch');
      }
      remaining(order);
    }
    if (
      state.yesOrder.priceRaw + state.noOrder.priceRaw !==
      CTF_EXCHANGE_PRICE_SCALE
    ) {
      throw new MigrationInvariantError('INVALID_SEED', 'Seed prices are not complements');
    }
    if (
      market.frozenYesPriceRaw !== null &&
      BigInt(market.frozenYesPriceRaw) !== state.yesOrder.priceRaw
    ) {
      throw new MigrationInvariantError('INVALID_SEED', 'Frozen price mismatch');
    }
    if (
      state.conditionStale &&
      ((state.yesOrder.open && remaining(state.yesOrder) > 0n) ||
        (state.noOrder.open && remaining(state.noOrder) > 0n))
    ) {
      throw new MigrationInvariantError(
        'INVALID_SEED',
        'Stale MiniCLOB condition still has an actionable protocol seed',
      );
    }
  }

  private async stageFromFreshSnapshot(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const state = await this.readState(migration);
    if (!state.conditionStale) {
      throw new MigrationInvariantError(
        'MINICLOB_NOT_STALE',
        'MiniCLOB cutover was not confirmed before snapshotting',
      );
    }
    return this.stageFromState(migration, state);
  }

  private registrationDisposition(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
  ): RegistrationDisposition {
    const { conditionId, yesTokenId, noTokenId } = this.stateInput(migration);
    const yesAbsent =
      state.yesRegistration.complementTokenId === 0n &&
      state.yesRegistration.conditionId.toLowerCase() === zeroHash &&
      state.yesRegistration.tradingEndsAt === 0n;
    const noAbsent =
      state.noRegistration.complementTokenId === 0n &&
      state.noRegistration.conditionId.toLowerCase() === zeroHash &&
      state.noRegistration.tradingEndsAt === 0n;
    if (yesAbsent && noAbsent) return 'ABSENT';
    const expectedCondition = conditionId.toLowerCase();
    if (
      state.yesRegistration.complementTokenId === noTokenId &&
      state.noRegistration.complementTokenId === yesTokenId &&
      state.yesRegistration.conditionId.toLowerCase() === expectedCondition &&
      state.noRegistration.conditionId.toLowerCase() === expectedCondition &&
      state.yesRegistration.tradingEndsAt === state.registryTradingEndsAt &&
      state.noRegistration.tradingEndsAt === state.registryTradingEndsAt
    ) {
      return 'REGISTERED';
    }
    return 'MISMATCHED';
  }

  private assertRegistrationNotMismatched(
    disposition: RegistrationDisposition,
  ): void {
    if (disposition === 'MISMATCHED') {
      throw new MigrationInvariantError(
        'TOKEN_REGISTRATION_MISMATCH',
        'CTFExchange token registration is partial or mismatched',
      );
    }
  }

  private async resumeAfterRegistration(
    migration: ClaimedMigration,
    blockNumber: number,
  ): Promise<MigrationIterationResult> {
    await this.checkpoint(migration, {
      status: 'PUBLISHING',
      registrationStatus: 'CONFIRMED',
      registrationBlockNumber: blockNumber,
      lastFailureCode: null,
      lastFailureMessage: null,
      lastFailureAt: null,
    });
    this.logger.info(`[migration] market=${migration.marketId} tokens registered`);
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async registerIfNeeded(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
  ): Promise<MigrationIterationResult | null> {
    if (!state.conditionStale) {
      throw new MigrationInvariantError(
        'MINICLOB_NOT_STALE',
        'CTFExchange cannot activate while MiniCLOB remains active',
      );
    }
    const disposition = this.registrationDisposition(migration, state);
    this.assertRegistrationNotMismatched(disposition);
    if (disposition === 'REGISTERED') {
      if (
        migration.registrationStatus !== 'CONFIRMED' ||
        migration.registrationBlockNumber === null
      ) {
        await this.holdCheckpoint(migration, {
          registrationStatus: 'CONFIRMED',
          registrationBlockNumber: state.blockNumber,
        });
      }
      return null;
    }
    if (!this.registrationEnabled) {
      return this.retry(migration, 'REGISTRATION_DISABLED', 60_000);
    }
    if (!state.registrationAuthorized) {
      throw new MigrationInvariantError(
        'REGISTRATION_UNAUTHORIZED',
        'Operator lacks CTFExchange ADMIN_ROLE',
      );
    }

    const { conditionId, yesTokenId, noTokenId } = this.stateInput(migration);
    await this.holdCheckpoint(migration, {
      status: 'REGISTRATION_SUBMITTING',
      registrationStatus: 'SUBMITTING',
      registrationTxHash: null,
      registrationBlockNumber: null,
      attemptCount: { increment: 1 },
    });
    let txHash: Hex;
    try {
      txHash = await this.submitter.submit(
        buildCtfExchangeRegisterTokenTx({
          tokenId: yesTokenId,
          complement: noTokenId,
          conditionId,
          tradingEndsAt: BigInt(migration.market.tradingEndsAt),
        }),
      );
    } catch (error) {
      // A provider can fail after broadcast. Chain state is the idempotency
      // authority, so observe both mappings before choosing retry or failure.
      const refreshed = await this.readState(migration);
      const refreshedDisposition = this.registrationDisposition(
        migration,
        refreshed,
      );
      this.assertRegistrationNotMismatched(refreshedDisposition);
      if (refreshedDisposition === 'REGISTERED') {
        return this.resumeAfterRegistration(migration, refreshed.blockNumber);
      }
      const failure = operatorFailure(error, migration.attemptCount + 1);
      if (failure.code.startsWith('RPC_')) {
        return this.registrationSubmissionUnknown(migration, failure);
      }
      return this.failTerminal(
        migration,
        `REGISTRATION_${failure.code}`,
        'CTFExchange token registration submission failed',
        { registrationStatus: 'FAILED' },
      );
    }
    try {
      await this.holdCheckpoint(migration, {
        status: 'REGISTRATION_SUBMITTED',
        registrationStatus: 'SUBMITTED',
        registrationTxHash: txHash.toLowerCase(),
      });
    } catch (error) {
      throw new RegistrationCheckpointError(error);
    }
    return this.confirmRegistration({
      ...migration,
      status: 'REGISTRATION_SUBMITTED',
      registrationStatus: 'SUBMITTED',
      registrationTxHash: txHash.toLowerCase(),
    });
  }

  private async reconcileUnknownRegistration(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const state = await this.readState(migration);
    if (!state.conditionStale) {
      throw new MigrationInvariantError(
        'MINICLOB_NOT_STALE',
        'Registration cannot be reconciled before MiniCLOB cutover',
      );
    }
    const disposition = this.registrationDisposition(migration, state);
    this.assertRegistrationNotMismatched(disposition);
    if (disposition === 'REGISTERED') {
      const result = await this.resumeAfterRegistration(
        migration,
        state.blockNumber,
      );
      this.logger.info(
        `[migration] market=${migration.marketId} ambiguous registration ` +
          'reconciled=landed',
      );
      return result;
    }

    // Both-zero still cannot distinguish a dropped transaction from one that
    // remains pending. Keep the migration quarantined until the exact pair is
    // observable; never submit a second admin transaction automatically.
    const now = this.now();
    await this.checkpoint(migration, {
      status: 'REGISTRATION_SUBMISSION_UNKNOWN',
      registrationStatus: 'SUBMISSION_UNKNOWN',
      nextAttemptAt:
        now + Math.ceil(REGISTRATION_UNKNOWN_RECHECK_MS / 1_000),
      lastFailureCode: 'REGISTRATION_OUTCOME_UNKNOWN',
      lastFailureMessage:
        'Token registration outcome remains unknown; awaiting exact on-chain pair',
      lastFailureAt: now,
    });
    this.logger.warn(
      `[migration] market=${migration.marketId} ` +
        'code=REGISTRATION_OUTCOME_UNKNOWN',
    );
    return {
      outcome: 'FAILED',
      marketId: migration.marketId,
      retryAfterMs: REGISTRATION_UNKNOWN_RECHECK_MS,
      failureCode: 'REGISTRATION_OUTCOME_UNKNOWN',
    };
  }

  private async confirmRegistration(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    if (migration.registrationTxHash === null) {
      return this.reconcileUnknownRegistration(migration);
    }
    let receipt;
    try {
      receipt = await this.submitter.confirm(migration.registrationTxHash as Hex);
    } catch (error) {
      const state = await this.readState(migration);
      if (!state.conditionStale) {
        throw new MigrationInvariantError(
          'MINICLOB_NOT_STALE',
          'Registration cannot be confirmed before MiniCLOB cutover',
        );
      }
      const disposition = this.registrationDisposition(migration, state);
      this.assertRegistrationNotMismatched(disposition);
      if (disposition === 'REGISTERED') {
        return this.resumeAfterRegistration(migration, state.blockNumber);
      }
      const failure = operatorFailure(error, migration.attemptCount + 1);
      return this.retry(
        migration,
        'REGISTRATION_CONFIRMATION_PENDING',
        failure.retryAfterMs,
      );
    }

    // Even a reverted or apparently successful receipt is secondary to the
    // exact pair now stored by CTFExchange. This also handles another actor
    // registering the same pair while our transaction was pending.
    const state = await this.readState(migration);
    if (!state.conditionStale) {
      throw new MigrationInvariantError(
        'MINICLOB_NOT_STALE',
        'Registration cannot be confirmed before MiniCLOB cutover',
      );
    }
    const disposition = this.registrationDisposition(migration, state);
    this.assertRegistrationNotMismatched(disposition);
    if (disposition === 'REGISTERED') {
      return this.resumeAfterRegistration(
        migration,
        Math.max(receipt.blockNumber, state.blockNumber),
      );
    }
    if (receipt.status === 'reverted') {
      return this.failTerminal(
        migration,
        'REGISTRATION_REVERTED',
        safeMessage('REGISTRATION_REVERTED'),
        { registrationStatus: 'REVERTED' },
      );
    }
    return this.failTerminal(
      migration,
      'REGISTRATION_NOT_APPLIED',
      safeMessage('REGISTRATION_NOT_APPLIED'),
      { registrationStatus: 'FAILED' },
    );
  }

  private async registrationSubmissionUnknown(
    migration: ClaimedMigration,
    failure: ReturnType<typeof operatorFailure>,
  ): Promise<MigrationIterationResult> {
    const now = this.now();
    await this.checkpoint(migration, {
      status: 'REGISTRATION_SUBMISSION_UNKNOWN',
      registrationStatus: 'SUBMISSION_UNKNOWN',
      registrationTxHash: null,
      registrationBlockNumber: null,
      nextAttemptAt: now + Math.max(1, Math.ceil(failure.retryAfterMs / 1_000)),
      lastFailureCode: failure.code,
      lastFailureMessage:
        'Transport failed after token registration may have been broadcast',
      lastFailureAt: now,
    });
    this.logger.warn(
      `[migration] market=${migration.marketId} code=${failure.code}`,
    );
    return {
      outcome: 'FAILED',
      marketId: migration.marketId,
      retryAfterMs: failure.retryAfterMs,
      failureCode: failure.code,
    };
  }

  private async stageFromState(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
  ): Promise<MigrationIterationResult> {
    const market = migration.market;
    if (market.yesTokenId === null || market.noTokenId === null) {
      throw new MigrationInvariantError('INVALID_SEED', 'Market token binding is missing');
    }
    if (this.tradingEnded(migration, state)) {
      return this.stageEndedHandoff(migration, state);
    }
    const minimumTickSizeRaw = BigInt(market.minimumTickSizeRaw);
    try {
      assertAllowedMinimumTickSizeRaw(minimumTickSizeRaw);
    } catch {
      throw new MigrationInvariantError(
        'INVALID_TICK_SIZE',
        'Market minimum tick size is outside the supported policy',
      );
    }
    if (zeroHandoff(state)) {
      return this.stageZeroHandoff(migration, state, minimumTickSizeRaw);
    }
    const yesOrder = stateOrder(state, 'YES');
    const noOrder = stateOrder(state, 'NO');
    const yesRealizedPriceRaw = quantizePriceRaw(
      yesOrder.priceRaw,
      minimumTickSizeRaw,
      'UP',
    );
    const noRealizedPriceRaw = ORDER_PRICE_SCALE_RAW - yesRealizedPriceRaw;
    if (
      yesRealizedPriceRaw <= 0n ||
      yesRealizedPriceRaw > ORDER_PRICE_SCALE_RAW ||
      noRealizedPriceRaw <= 0n ||
      noRealizedPriceRaw > ORDER_PRICE_SCALE_RAW
    ) {
      throw new MigrationInvariantError(
        'MIGRATION_PRICE_OUT_OF_RANGE',
        'Complementary tick quantization produced an invalid replacement price',
      );
    }
    const yesPriceDeviationRaw =
      yesRealizedPriceRaw - yesOrder.priceRaw;
    const noPriceDeviationRaw =
      noRealizedPriceRaw - noOrder.priceRaw;
    if (
      yesPriceDeviationRaw < 0n ||
      yesPriceDeviationRaw >= minimumTickSizeRaw ||
      yesPriceDeviationRaw > MAX_MIGRATION_PRICE_DEVIATION_RAW ||
      noPriceDeviationRaw !== -yesPriceDeviationRaw
    ) {
      throw new MigrationInvariantError(
        'MIGRATION_PRICE_DEVIATION',
        'Replacement price exceeded the bounded one-tick migration tolerance',
      );
    }
    const prices = {
      YES: yesRealizedPriceRaw,
      NO: noRealizedPriceRaw,
    } as const;
    const replacements = await Promise.all(
      (['YES', 'NO'] as const).map(async (outcome) => {
        const seed = stateOrder(state, outcome);
        const sizeRaw = floorOrderSizeToGranularity(remaining(seed));
        if (sizeRaw === 0n) return null;
        const salt = generateOrderSalt();
        const unsigned = buildCtfExchangeOrder({
          maker: this.account.address,
          tokenId: seed.tokenId,
          side: Side.SELL,
          priceRaw: prices[outcome],
          sizeRaw,
          nonce: state.makerNonce,
          expiration: BigInt(market.tradingEndsAt),
          salt,
        });
        if (ctfExchangeOrderTerms(unsigned).priceRaw !== prices[outcome]) {
          throw new MigrationInvariantError(
            'UNREPRESENTABLE_PRICE',
            'Granular replacement size cannot encode the quantized price exactly',
          );
        }
        const order = await signCtfExchangeOrder(this.account, unsigned);
        return {
          outcome,
          order,
          orderHash: hashCtfExchangeOrder(order).toLowerCase(),
        };
      }),
    );
    const yesReplacement = replacements.find((item) => item?.outcome === 'YES') ?? null;
    const noReplacement = replacements.find((item) => item?.outcome === 'NO') ?? null;
    const oldHashes = [
      migration.yesReplacementOrderHash,
      migration.noReplacementOrderHash,
    ].filter((hash): hash is string => hash !== null);
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      if (oldHashes.length > 0) {
        await tx.signedOrder.updateMany({
          where: { orderHash: { in: oldHashes }, status: 'STAGED' },
          data: { status: 'SUPERSEDED', updatedAt: now },
        });
      }
      for (const replacement of replacements) {
        if (replacement === null) continue;
        await tx.signedOrder.create({
          data: signedOrderCreateData({
            orderHash: replacement.orderHash,
            order: replacement.order,
            marketId: market.id,
            conditionId: market.conditionId,
            outcome: replacement.outcome,
            status: 'STAGED',
            origin: 'BOOK_MIGRATION',
            now,
          }),
        });
      }
      const updated = await tx.bookMigration.updateMany({
        where: { marketId: migration.marketId, claimToken: migration.claimToken },
        data: {
          status: 'STAGED',
          snapshotBlockNumber: state.blockNumber,
          snapshotNonceRaw: state.makerNonce.toString(),
          yesPriceRaw: yesOrder.priceRaw.toString(),
          noPriceRaw: noOrder.priceRaw.toString(),
          yesSnapshotRemainingRaw: remaining(yesOrder).toString(),
          noSnapshotRemainingRaw: remaining(noOrder).toString(),
          minimumTickSizeRaw: minimumTickSizeRaw.toString(),
          yesRealizedPriceRaw: yesRealizedPriceRaw.toString(),
          noRealizedPriceRaw: noRealizedPriceRaw.toString(),
          yesPriceDeviationRaw: yesPriceDeviationRaw.toString(),
          noPriceDeviationRaw: noPriceDeviationRaw.toString(),
          yesReplacementSizeRaw: floorOrderSizeToGranularity(
            remaining(yesOrder),
          ).toString(),
          noReplacementSizeRaw: floorOrderSizeToGranularity(
            remaining(noOrder),
          ).toString(),
          yesUnquotedRemainderRaw: (
            remaining(yesOrder) -
            floorOrderSizeToGranularity(remaining(yesOrder))
          ).toString(),
          noUnquotedRemainderRaw: (
            remaining(noOrder) -
            floorOrderSizeToGranularity(remaining(noOrder))
          ).toString(),
          yesReplacementOrderHash: yesReplacement?.orderHash ?? null,
          noReplacementOrderHash: noReplacement?.orderHash ?? null,
          approvalStatus: state.ctfApprovedForAll
            ? 'CONFIRMED'
            : replacements.some((replacement) => replacement !== null)
              ? 'PENDING'
              : 'NOT_REQUIRED',
          approvalBlockNumber: state.ctfApprovedForAll
            ? state.blockNumber
            : migration.approvalBlockNumber,
          yesCancelStatus: cancelStatus(yesOrder),
          noCancelStatus: cancelStatus(noOrder),
          activeCancelOutcome: null,
          nextAttemptAt: 0,
          lastFailureCode: null,
          lastFailureMessage: null,
          lastFailureAt: null,
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        },
      });
      if (updated.count !== 1) throw new Error('Book migration claim was lost');
    });
    this.logger.info(`[migration] market=${migration.marketId} replacements staged`);
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async stageEndedHandoff(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
  ): Promise<MigrationIterationResult> {
    if (!state.conditionStale) {
      throw new MigrationInvariantError(
        'MINICLOB_NOT_STALE',
        'Ended migration cannot stage before MiniCLOB cutover',
      );
    }
    const noSeeds = zeroHandoff(state);
    const yesOrder = noSeeds ? null : stateOrder(state, 'YES');
    const noOrder = noSeeds ? null : stateOrder(state, 'NO');
    const yesRecovered = yesOrder === null ? 0n : remaining(yesOrder);
    const noRecovered = noOrder === null ? 0n : remaining(noOrder);
    if (
      state.yesBalanceRaw < yesRecovered ||
      state.noBalanceRaw < noRecovered
    ) {
      throw new MigrationInvariantError(
        'MISSING_RECOVERED_BALANCE',
        'Recovered token balance is below the ended handoff inventory',
      );
    }

    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.signedOrder.updateMany({
        where: {
          marketId: migration.marketId,
          origin: 'BOOK_MIGRATION',
          status: 'STAGED',
        },
        data: { status: 'EXPIRED', updatedAt: now },
      });
      const updated = await tx.bookMigration.updateMany({
        where: { marketId: migration.marketId, claimToken: migration.claimToken },
        data: {
          status: 'STAGED',
          snapshotBlockNumber: state.blockNumber,
          snapshotNonceRaw: state.makerNonce.toString(),
          yesPriceRaw: yesOrder?.priceRaw.toString() ?? null,
          noPriceRaw: noOrder?.priceRaw.toString() ?? null,
          yesSnapshotRemainingRaw: yesRecovered.toString(),
          noSnapshotRemainingRaw: noRecovered.toString(),
          minimumTickSizeRaw: migration.market.minimumTickSizeRaw,
          yesRealizedPriceRaw: null,
          noRealizedPriceRaw: null,
          yesPriceDeviationRaw: null,
          noPriceDeviationRaw: null,
          yesReplacementSizeRaw: '0',
          noReplacementSizeRaw: '0',
          yesUnquotedRemainderRaw: yesRecovered.toString(),
          noUnquotedRemainderRaw: noRecovered.toString(),
          yesReplacementOrderHash: null,
          noReplacementOrderHash: null,
          approvalStatus: 'NOT_REQUIRED',
          yesCancelStatus:
            yesOrder === null ? 'NOT_REQUIRED' : cancelStatus(yesOrder),
          noCancelStatus:
            noOrder === null ? 'NOT_REQUIRED' : cancelStatus(noOrder),
          activeCancelOutcome: null,
          yesRecoveredRaw: yesRecovered.toString(),
          noRecoveredRaw: noRecovered.toString(),
          yesBalanceRaw: state.yesBalanceRaw.toString(),
          noBalanceRaw: state.noBalanceRaw.toString(),
          recoveryBlockNumber: Math.max(
            migration.recoveryBlockNumber ?? 0,
            state.blockNumber,
          ),
          cancelledAt: migration.cancelledAt ?? now,
          nextAttemptAt: 0,
          lastFailureCode: null,
          lastFailureMessage: null,
          lastFailureAt: null,
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        },
      });
      if (updated.count !== 1) throw new Error('Book migration claim was lost');
    });
    this.logger.info(
      `[migration] market=${migration.marketId} trading=ENDED replacements=SKIPPED`,
    );
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async stageZeroHandoff(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
    minimumTickSizeRaw: bigint,
  ): Promise<MigrationIterationResult> {
    const oldHashes = [
      migration.yesReplacementOrderHash,
      migration.noReplacementOrderHash,
    ].filter((hash): hash is string => hash !== null);
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      if (oldHashes.length > 0) {
        await tx.signedOrder.updateMany({
          where: { orderHash: { in: oldHashes }, status: 'STAGED' },
          data: { status: 'SUPERSEDED', updatedAt: now },
        });
      }
      const updated = await tx.bookMigration.updateMany({
        where: { marketId: migration.marketId, claimToken: migration.claimToken },
        data: {
          status: 'STAGED',
          snapshotBlockNumber: state.blockNumber,
          snapshotNonceRaw: state.makerNonce.toString(),
          yesPriceRaw: null,
          noPriceRaw: null,
          yesSnapshotRemainingRaw: '0',
          noSnapshotRemainingRaw: '0',
          minimumTickSizeRaw: minimumTickSizeRaw.toString(),
          yesRealizedPriceRaw: null,
          noRealizedPriceRaw: null,
          yesPriceDeviationRaw: null,
          noPriceDeviationRaw: null,
          yesReplacementSizeRaw: '0',
          noReplacementSizeRaw: '0',
          yesUnquotedRemainderRaw: '0',
          noUnquotedRemainderRaw: '0',
          yesReplacementOrderHash: null,
          noReplacementOrderHash: null,
          approvalStatus: 'NOT_REQUIRED',
          yesCancelStatus: 'NOT_REQUIRED',
          noCancelStatus: 'NOT_REQUIRED',
          yesRecoveredRaw: '0',
          noRecoveredRaw: '0',
          activeCancelOutcome: null,
          nextAttemptAt: 0,
          lastFailureCode: null,
          lastFailureMessage: null,
          lastFailureAt: null,
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        },
      });
      if (updated.count !== 1) throw new Error('Book migration claim was lost');
    });
    this.logger.info(`[migration] market=${migration.marketId} zero handoff staged`);
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async stagedMatches(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
  ): Promise<boolean> {
    const hashes = [
      migration.yesReplacementOrderHash,
      migration.noReplacementOrderHash,
    ].filter((hash): hash is string => hash !== null);
    if (this.tradingEnded(migration, state)) {
      const noSeeds = zeroHandoff(state);
      const yesRecovered = noSeeds ? 0n : remaining(stateOrder(state, 'YES'));
      const noRecovered = noSeeds ? 0n : remaining(stateOrder(state, 'NO'));
      const stagedCount = await this.prisma.signedOrder.count({
        where: {
          marketId: migration.marketId,
          origin: 'BOOK_MIGRATION',
          status: 'STAGED',
        },
      });
      return (
        hashes.length === 0 &&
        stagedCount === 0 &&
        migration.yesSnapshotRemainingRaw === yesRecovered.toString() &&
        migration.noSnapshotRemainingRaw === noRecovered.toString() &&
        migration.yesReplacementSizeRaw === '0' &&
        migration.noReplacementSizeRaw === '0' &&
        migration.yesUnquotedRemainderRaw === yesRecovered.toString() &&
        migration.noUnquotedRemainderRaw === noRecovered.toString()
      );
    }
    if (zeroHandoff(state)) {
      return (
        hashes.length === 0 &&
        migration.yesSnapshotRemainingRaw === '0' &&
        migration.noSnapshotRemainingRaw === '0' &&
        migration.yesReplacementSizeRaw === '0' &&
        migration.noReplacementSizeRaw === '0'
      );
    }
    const yesOrder = stateOrder(state, 'YES');
    const noOrder = stateOrder(state, 'NO');
    const rows = await this.prisma.signedOrder.findMany({
      where: { orderHash: { in: hashes } },
    });
    const byHash = new Map(rows.map((row) => [row.orderHash, row]));
    if (
      migration.minimumTickSizeRaw === null ||
      migration.yesRealizedPriceRaw === null ||
      migration.noRealizedPriceRaw === null ||
      migration.yesSnapshotRemainingRaw !== remaining(yesOrder).toString() ||
      migration.noSnapshotRemainingRaw !== remaining(noOrder).toString()
    ) {
      return false;
    }
    for (const outcome of ['YES', 'NO'] as const) {
      const expectedSize = floorOrderSizeToGranularity(
        remaining(stateOrder(state, outcome)),
      );
      const expectedPrice = BigInt(
        outcome === 'YES'
          ? migration.yesRealizedPriceRaw
          : migration.noRealizedPriceRaw,
      );
      const hash =
        outcome === 'YES'
          ? migration.yesReplacementOrderHash
          : migration.noReplacementOrderHash;
      if (expectedSize === 0n) {
        if (hash !== null) return false;
        continue;
      }
      if (hash === null) return false;
      const row = byHash.get(hash);
      if (
        row === undefined ||
        row.status !== 'STAGED' ||
        row.origin !== 'BOOK_MIGRATION' ||
        row.outcome !== outcome ||
        BigInt(row.sizeRaw) !== expectedSize ||
        BigInt(row.priceRaw) !== expectedPrice ||
        BigInt(row.nonceRaw) !== state.makerNonce ||
        BigInt(row.expiration) !== BigInt(migration.market.tradingEndsAt)
      ) {
        return false;
      }
    }
    return true;
  }

  private async prepareApprovalOrRegistration(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const state = await this.readState(migration);
    if (!state.conditionStale) {
      throw new MigrationInvariantError(
        'MINICLOB_NOT_STALE',
        'MiniCLOB became active again after cutover',
      );
    }
    if (!(await this.stagedMatches(migration, state))) {
      return this.stageFromState(migration, state);
    }
    if (hasReplacements(migration) && !state.ctfApprovedForAll) {
      await this.holdCheckpoint(migration, {
        status: 'APPROVAL_SUBMITTING',
        approvalStatus: 'SUBMITTING',
        attemptCount: { increment: 1 },
      });
      let txHash: Hex;
      try {
        txHash = await this.submitter.submit(buildCtfExchangeApprovalForAllTx());
      } catch (error) {
        const failure = operatorFailure(error, migration.attemptCount + 1);
        if (failure.code.startsWith('RPC_')) {
          return this.submissionUnknown(
            migration,
            'APPROVAL_SUBMISSION_UNKNOWN',
            failure,
          );
        }
        return this.failTerminal(
          migration,
          failure.code,
          'CTFExchange token approval submission failed',
        );
      }
      await this.holdCheckpoint(migration, {
        status: 'APPROVAL_SUBMITTED',
        approvalStatus: 'SUBMITTED',
        approvalTxHash: txHash.toLowerCase(),
      });
      return this.confirmApproval({
        ...migration,
        status: 'APPROVAL_SUBMITTED',
        approvalStatus: 'SUBMITTED',
        approvalTxHash: txHash.toLowerCase(),
      });
    }

    if (hasReplacements(migration)) {
      await this.holdCheckpoint(migration, {
        approvalStatus: 'CONFIRMED',
        approvalBlockNumber: state.blockNumber,
      });
    }
    const registration = await this.registerIfNeeded(migration, state);
    if (registration !== null) return registration;
    await this.checkpoint(migration, { status: 'PUBLISHING' });
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async reconcileUnknownApproval(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const state = await this.readState(migration);
    if (!state.conditionStale) {
      throw new MigrationInvariantError('MINICLOB_NOT_STALE', 'MiniCLOB is active');
    }
    if (this.tradingEnded(migration, state)) {
      return this.stageEndedHandoff(migration, state);
    }
    await this.checkpoint(migration, {
      status: 'STAGED',
      approvalStatus: state.ctfApprovedForAll ? 'CONFIRMED' : 'PENDING',
      approvalBlockNumber: state.ctfApprovedForAll
        ? state.blockNumber
        : migration.approvalBlockNumber,
    });
    this.logger.info(
      `[migration] market=${migration.marketId} ambiguous approval reconciled`,
    );
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async confirmApproval(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const beforeReceipt = await this.readState(migration);
    if (!beforeReceipt.conditionStale) {
      throw new MigrationInvariantError('MINICLOB_NOT_STALE', 'MiniCLOB is active');
    }
    if (this.tradingEnded(migration, beforeReceipt)) {
      return this.stageEndedHandoff(migration, beforeReceipt);
    }
    if (migration.approvalTxHash === null) {
      return this.reconcileUnknownApproval(migration);
    }
    let receipt;
    try {
      receipt = await this.submitter.confirm(migration.approvalTxHash as Hex);
    } catch (error) {
      const failure = operatorFailure(error, migration.attemptCount + 1);
      return this.retry(
        migration,
        'APPROVAL_CONFIRMATION_PENDING',
        failure.retryAfterMs,
      );
    }
    if (receipt.status === 'reverted') {
      return this.failTerminal(
        migration,
        'APPROVAL_REVERTED',
        safeMessage('APPROVAL_REVERTED'),
      );
    }
    const state = await this.readState(migration);
    if (!state.conditionStale) {
      throw new MigrationInvariantError('MINICLOB_NOT_STALE', 'MiniCLOB is active');
    }
    if (this.tradingEnded(migration, state)) {
      return this.stageEndedHandoff(migration, state);
    }
    if (hasReplacements(migration) && !state.ctfApprovedForAll) {
      return this.failTerminal(
        migration,
        'APPROVAL_NOT_APPLIED',
        'Confirmed approval did not grant CTFExchange access',
      );
    }
    await this.checkpoint(migration, {
      status: 'STAGED',
      approvalStatus: hasReplacements(migration) ? 'CONFIRMED' : 'NOT_REQUIRED',
      approvalBlockNumber: hasReplacements(migration)
        ? Math.max(receipt.blockNumber, state.blockNumber)
        : migration.approvalBlockNumber,
    });
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async prepareOrSubmitCutover(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const state = await this.readState(migration);
    const registration = this.registrationDisposition(migration, state);
    this.assertRegistrationNotMismatched(registration);
    if (
      !state.conditionStale &&
      !this.tradingEnded(migration, state) &&
      registration === 'ABSENT' &&
      !this.registrationEnabled
    ) {
      return this.retry(migration, 'REGISTRATION_DISABLED', 60_000);
    }
    if (
      !state.conditionStale &&
      !this.tradingEnded(migration, state) &&
      registration === 'ABSENT' &&
      !state.registrationAuthorized
    ) {
      throw new MigrationInvariantError(
        'REGISTRATION_UNAUTHORIZED',
        'Operator lacks the activation role required after cutover',
      );
    }
    if (state.conditionStale) {
      return this.recordCutoverComplete(migration, state);
    }

    await this.holdCheckpoint(migration, {
      status: 'CANCEL_SUBMITTING',
      cutoverTxHash: null,
      activeCancelOutcome: null,
      yesCancelStatus: 'SUBMITTING',
      noCancelStatus: 'SUBMITTING',
      attemptCount: { increment: 1 },
    });
    let txHash: Hex;
    try {
      txHash = await this.submitter.submit(
        buildMiniClobCutoverTx({
          conditionId: migration.market.conditionId as Hex,
        }),
      );
    } catch (error) {
      const failure = operatorFailure(error, migration.attemptCount + 1);
      if (failure.code.startsWith('RPC_')) {
        return this.cutoverSubmissionUnknown(
          migration,
          failure.code,
          failure.retryAfterMs,
        );
      }
      return this.failTerminal(
        migration,
        `CUTOVER_${failure.code}`,
        'MiniCLOB cutover submission failed',
      );
    }
    try {
      await this.holdCheckpoint(migration, {
        status: 'CANCEL_SUBMITTED',
        cutoverTxHash: txHash.toLowerCase(),
        yesCancelStatus: 'SUBMITTED',
        noCancelStatus: 'SUBMITTED',
      });
    } catch (error) {
      throw new CutoverCheckpointError(error);
    }
    return this.confirmCutover({
      ...migration,
      status: 'CANCEL_SUBMITTED',
      cutoverTxHash: txHash.toLowerCase(),
      yesCancelStatus: 'SUBMITTED',
      noCancelStatus: 'SUBMITTED',
    });
  }

  private async reconcileUnknownCutover(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const state = await this.readState(migration);
    if (state.conditionStale) {
      this.logger.info(
        `[migration] market=${migration.marketId} ambiguous cutover reconciled=landed`,
      );
      return this.recordCutoverComplete(migration, state);
    }
    return this.cutoverSubmissionUnknown(
      migration,
      'CUTOVER_OUTCOME_UNKNOWN',
      CUTOVER_UNKNOWN_RECHECK_MS,
    );
  }

  private async confirmCutover(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    if (migration.cutoverTxHash === null) {
      return this.reconcileUnknownCutover(migration);
    }
    let receipt;
    try {
      receipt = await this.submitter.confirm(migration.cutoverTxHash as Hex);
    } catch (error) {
      const failure = operatorFailure(error, migration.attemptCount + 1);
      return this.retry(
        migration,
        'CUTOVER_CONFIRMATION_PENDING',
        failure.retryAfterMs,
      );
    }
    const state = await this.readState(migration);
    if (state.conditionStale) {
      return this.recordCutoverComplete(migration, state, receipt.blockNumber);
    }
    if (receipt.status === 'reverted') {
      return this.failTerminal(
        migration,
        'CUTOVER_REVERTED',
        safeMessage('CUTOVER_REVERTED'),
      );
    }
    return this.failTerminal(
      migration,
      'CUTOVER_NOT_APPLIED',
      safeMessage('CUTOVER_NOT_APPLIED'),
    );
  }

  private async recordCutoverComplete(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
    receiptBlockNumber = 0,
  ): Promise<MigrationIterationResult> {
    if (!state.conditionStale) {
      throw new MigrationInvariantError(
        'MINICLOB_NOT_STALE',
        'MiniCLOB cutover is not authoritative on-chain',
      );
    }
    const noSeeds = zeroHandoff(state);
    const yesRecovered = noSeeds ? 0n : remaining(stateOrder(state, 'YES'));
    const noRecovered = noSeeds ? 0n : remaining(stateOrder(state, 'NO'));
    const now = this.now();
    await this.checkpoint(migration, {
      status: 'CANCELLED',
      activeCancelOutcome: null,
      yesCancelStatus: noSeeds
        ? 'NOT_REQUIRED'
        : cancelStatus(stateOrder(state, 'YES')),
      noCancelStatus: noSeeds
        ? 'NOT_REQUIRED'
        : cancelStatus(stateOrder(state, 'NO')),
      yesRecoveredRaw: yesRecovered.toString(),
      noRecoveredRaw: noRecovered.toString(),
      yesBalanceRaw: state.yesBalanceRaw.toString(),
      noBalanceRaw: state.noBalanceRaw.toString(),
      recoveryBlockNumber: state.blockNumber,
      cancelBlockNumber: Math.max(
        migration.cancelBlockNumber ?? 0,
        receiptBlockNumber,
        state.blockNumber,
      ),
      cancelledAt: migration.cancelledAt ?? now,
      lastFailureCode: null,
      lastFailureMessage: null,
      lastFailureAt: null,
    });
    this.logger.info(`[migration] market=${migration.marketId} MiniCLOB stale`);
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private tradingEnded(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
  ): boolean {
    return state.blockTimestamp >= BigInt(migration.market.tradingEndsAt);
  }

  private validateReplacementPreflight(
    row: SignedOrder,
    state: FreshOrderChainState,
    expectedComplement: bigint,
  ): void {
    const result = preflightSignedOrder({
      order: row,
      state: {
        nonce: state.makerNonce,
        complement: state.complementTokenId,
        conditionId: state.registeredConditionId,
        registeredTradingEndsAt: state.registeredTradingEndsAt,
        payoutDenominator: state.payoutDenominator,
        balanceRaw: state.makerAssetBalance,
        approval: state.ctfApprovedForAll ?? false,
      },
      fillSizeRaw: BigInt(row.remainingRaw),
      blockTimestamp: state.blockTimestamp,
      blockNumber: state.blockNumber,
      expectedComplement,
    });
    if (!result.ok) {
      throw new MigrationInvariantError(result.code, result.message);
    }
  }

  private async publish(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const state = await this.readState(migration);
    if (!state.conditionStale) {
      throw new MigrationInvariantError(
        'MINICLOB_NOT_STALE',
        'Hybrid publication requires a fresh MiniCLOB stale read',
      );
    }
    const registration = this.registrationDisposition(migration, state);
    this.assertRegistrationNotMismatched(registration);
    if (registration !== 'REGISTERED') {
      throw new MigrationInvariantError(
        'TOKEN_NOT_REGISTERED',
        'Hybrid publication requires the exact registered token pair',
      );
    }
    if (!(await this.stagedMatches(migration, state))) {
      return this.stageFromState(migration, state);
    }
    const hashes = [
      migration.yesReplacementOrderHash,
      migration.noReplacementOrderHash,
    ].filter((hash): hash is string => hash !== null);
    if (hashes.length > 0 && !state.ctfApprovedForAll) {
      await this.checkpoint(migration, {
        status: 'STAGED',
        approvalStatus: 'PENDING',
      });
      return { outcome: 'PROGRESSED', marketId: migration.marketId };
    }
    const noSeeds = zeroHandoff(state);
    const yesRecovered = noSeeds ? 0n : remaining(stateOrder(state, 'YES'));
    const noRecovered = noSeeds ? 0n : remaining(stateOrder(state, 'NO'));
    if (
      state.yesBalanceRaw < yesRecovered ||
      state.noBalanceRaw < noRecovered
    ) {
      throw new MigrationInvariantError(
        'MISSING_RECOVERED_BALANCE',
        'Recovered token balance is below the replacement size',
      );
    }

    const rows = await this.prisma.signedOrder.findMany({
      where: { orderHash: { in: hashes }, status: 'STAGED' },
      orderBy: { outcome: 'asc' },
    });
    if (rows.length !== hashes.length) {
      throw new MigrationInvariantError('INVALID_STAGED_ORDER', 'Staged order is missing');
    }
    const validations: Array<{ row: SignedOrder; state: FreshOrderChainState }> = [];
    for (const row of rows) {
      const fresh = await this.chainReader.readOrderState(
        signedOrderFromRow(row),
        migration.market.conditionId as Hex,
      );
      if (fresh.blockTimestamp >= fresh.registeredTradingEndsAt) {
        const endedState = await this.readState(migration);
        if (this.tradingEnded(migration, endedState)) {
          return this.stageFromState(migration, endedState);
        }
      }
      const expectedComplement = BigInt(
        row.outcome === 'YES'
          ? migration.market.noTokenId ?? '0'
          : migration.market.yesTokenId ?? '0',
      );
      this.validateReplacementPreflight(row, fresh, expectedComplement);
      validations.push({ row, state: fresh });
    }

    const now = this.now();
    const recoveryBlock = Math.max(
      state.blockNumber,
      ...validations.map((validation) => validation.state.blockNumber),
    );
    await this.prisma.$transaction(async (tx) => {
      for (const validation of validations) {
        await persistOrderValidationSnapshot(
          tx,
          signedOrderFromRow(validation.row),
          validation.state,
          now,
        );
      }
      const published = await tx.signedOrder.updateMany({
        where: { orderHash: { in: hashes }, status: 'STAGED' },
        data: { status: 'OPEN', updatedAt: now },
      });
      if (published.count !== hashes.length) {
        throw new Error('Staged replacement publication was not atomic');
      }
      const completed = await tx.bookMigration.updateMany({
        where: {
          marketId: migration.marketId,
          claimToken: migration.claimToken,
          status: 'PUBLISHING',
        },
        data: {
          status: 'MIGRATED',
          approvalStatus: hashes.length > 0 ? 'CONFIRMED' : 'NOT_REQUIRED',
          approvalBlockNumber:
            hashes.length > 0
              ? Math.max(migration.approvalBlockNumber ?? 0, state.blockNumber)
              : migration.approvalBlockNumber,
          yesRecoveredRaw: yesRecovered.toString(),
          noRecoveredRaw: noRecovered.toString(),
          yesBalanceRaw: state.yesBalanceRaw.toString(),
          noBalanceRaw: state.noBalanceRaw.toString(),
          recoveryBlockNumber: recoveryBlock,
          migratedAt: now,
          nextAttemptAt: 0,
          lastFailureCode: null,
          lastFailureMessage: null,
          lastFailureAt: null,
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        },
      });
      if (completed.count !== 1) throw new Error('Book migration claim was lost');
    });
    this.logger.info(`[migration] market=${migration.marketId} venue=HYBRID`);
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async holdCheckpoint(
    migration: ClaimedMigration,
    data: Prisma.BookMigrationUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await this.prisma.bookMigration.updateMany({
      where: { marketId: migration.marketId, claimToken: migration.claimToken },
      data: { ...data, updatedAt: this.now() },
    });
    if (updated.count !== 1) throw new Error('Book migration claim was lost');
  }

  private async checkpoint(
    migration: ClaimedMigration,
    data: Prisma.BookMigrationUpdateManyMutationInput,
  ): Promise<void> {
    await this.holdCheckpoint(migration, {
      nextAttemptAt: 0,
      ...data,
      claimToken: null,
      claimExpiresAt: null,
    });
  }

  private async submissionUnknown(
    migration: ClaimedMigration,
    status: 'APPROVAL_SUBMISSION_UNKNOWN',
    failure: ReturnType<typeof operatorFailure>,
  ): Promise<MigrationIterationResult> {
    const now = this.now();
    await this.checkpoint(migration, {
      status,
      approvalStatus: 'SUBMISSION_UNKNOWN',
      nextAttemptAt: now + Math.max(1, Math.ceil(failure.retryAfterMs / 1_000)),
      lastFailureCode: failure.code,
      lastFailureMessage: 'Transport failed after submission may have been broadcast',
      lastFailureAt: now,
    });
    this.logger.warn(
      `[migration] market=${migration.marketId} code=${failure.code}`,
    );
    return {
      outcome: 'FAILED',
      marketId: migration.marketId,
      retryAfterMs: failure.retryAfterMs,
      failureCode: failure.code,
    };
  }

  private async cutoverSubmissionUnknown(
    migration: ClaimedMigration,
    failureCode: string,
    retryAfterMs: number,
  ): Promise<MigrationIterationResult> {
    const now = this.now();
    const delay = Math.max(CUTOVER_UNKNOWN_RECHECK_MS, retryAfterMs);
    await this.checkpoint(migration, {
      status: 'CANCEL_SUBMISSION_UNKNOWN',
      cutoverTxHash: null,
      yesCancelStatus: 'SUBMISSION_UNKNOWN',
      noCancelStatus: 'SUBMISSION_UNKNOWN',
      nextAttemptAt: now + Math.max(1, Math.ceil(delay / 1_000)),
      lastFailureCode: failureCode,
      lastFailureMessage:
        'Cutover may have been broadcast; awaiting authoritative MiniCLOB stale state',
      lastFailureAt: now,
    });
    this.logger.warn(
      `[migration] market=${migration.marketId} code=${failureCode}`,
    );
    return {
      outcome: 'FAILED',
      marketId: migration.marketId,
      retryAfterMs: delay,
      failureCode,
    };
  }

  private async retry(
    migration: ClaimedMigration,
    failureCode: string,
    retryAfterMs: number,
  ): Promise<MigrationIterationResult> {
    const now = this.now();
    await this.checkpoint(migration, {
      attemptCount: { increment: 1 },
      nextAttemptAt: now + Math.max(1, Math.ceil(retryAfterMs / 1_000)),
      lastFailureCode: failureCode,
      lastFailureMessage: 'Transient migration dependency is unavailable',
      lastFailureAt: now,
    });
    this.logger.warn(`[migration] market=${migration.marketId} code=${failureCode}`);
    return {
      outcome: 'FAILED',
      marketId: migration.marketId,
      retryAfterMs,
      failureCode,
    };
  }

  private async failTerminal(
    migration: ClaimedMigration,
    failureCode: string,
    failureMessage: string,
    extraData: Prisma.BookMigrationUpdateManyMutationInput = {},
  ): Promise<MigrationIterationResult> {
    const now = this.now();
    await this.checkpoint(migration, {
      ...extraData,
      status: 'FAILED',
      lastFailureCode: failureCode,
      lastFailureMessage: failureMessage,
      lastFailureAt: now,
    });
    this.logger.warn(`[migration] market=${migration.marketId} code=${failureCode}`);
    return {
      outcome: 'FAILED',
      marketId: migration.marketId,
      retryAfterMs: 0,
      failureCode,
    };
  }
}
