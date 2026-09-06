import { lstat, readFile } from 'node:fs/promises';

import type { PrismaClient } from '@prisma/client';
import { ADDRESSES } from '@predex-pump/shared';
import {
  buildCtfExchangeMatchOrdersTx,
  type TxRequest,
} from '@predex-pump/shared/tx';
import {
  createWalletClient,
  http,
  isAddressEqual,
  type Hex,
  type LocalAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { inspectRpcError, retryDelayMs } from '../indexer/retry.js';
import { ARC_CHAIN, createArcPublicClient } from './chain-reader.js';
import {
  reserveNextCrossingMatch,
  type ReservedMatch,
} from './matcher.js';
import { signedOrderFromRow } from './order.js';
import type {
  PreflightFailureCode,
  SettlementPreflight,
} from './preflight.js';

export interface SettlementSubmitter {
  submit(transaction: TxRequest): Promise<Hex>;
}

export interface ConfirmedTransaction {
  status: 'success' | 'reverted';
  blockNumber: number;
}

export interface OperatorTransactionSubmitter extends SettlementSubmitter {
  confirm(txHash: Hex): Promise<ConfirmedTransaction>;
}

export interface OperatorLogger {
  info(message: string): void;
  warn(message: string): void;
}

const consoleOperatorLogger: OperatorLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
};

export type OperatorIterationResult =
  | { outcome: 'IDLE' | 'SKIPPED' | 'BLOCKED' | 'SUBMITTED'; matchId?: string }
  | {
      outcome: 'FAILED';
      matchId: string;
      retryAfterMs: number;
      failureCode: string;
    };

export interface OperatorLoopWorker {
  processOnce(): Promise<{
    outcome: string;
    retryAfterMs?: number;
  }>;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

export function operatorFailure(error: unknown, attempt = 1): {
  code: string;
  message: string;
  retryAfterMs: number;
} {
  const rpc = inspectRpcError(error);
  if (rpc !== null) {
    return {
      code: rpc.kind === 'rate-limit' ? 'RPC_RATE_LIMIT' : 'RPC_TRANSIENT',
      message: rpc.summary
        .replace(/0x[0-9a-f]{40,}/giu, '[hex-redacted]')
        .slice(0, 240),
      retryAfterMs: retryDelayMs(attempt, rpc),
    };
  }
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name ?? 'Error')
      : 'Error';
  return {
    code: /revert|contractfunction/iu.test(name) ? 'SUBMIT_REVERT' : 'SUBMIT_FAILED',
    // Never persist an RPC error body: viem may include calldata and signatures.
    message: `${name}: settlement submission failed`,
    retryAfterMs: 1_000,
  };
}

function statusForPreflightFailure(
  code: PreflightFailureCode,
): string | undefined {
  if (code === 'MARKET_RESOLVED') return 'MARKET_RESOLVED';
  if (code === 'WRONG_NONCE') return 'NONCE_INVALIDATED';
  if (code === 'EXPIRED') return 'EXPIRED';
  if (code === 'ORDER_CANCELLED') return 'CANCELLED';
  return undefined;
}

async function recordOrderFailure(
  prisma: PrismaClient,
  match: ReservedMatch,
  code: string,
  message: string,
  now: number,
  status?: string,
): Promise<void> {
  await prisma.signedOrder.updateMany({
    where: {
      orderHash: {
        in: [match.takerOrder.orderHash, match.makerOrder.orderHash],
      },
    },
    data: {
      ...(status === undefined ? {} : { status }),
      lastFailureCode: code,
      lastFailureMessage: message,
      lastFailureAt: now,
      updatedAt: now,
    },
  });
}

export class SettlementOperator {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly preflight: SettlementPreflight,
    private readonly submitter: SettlementSubmitter,
    private readonly logger: OperatorLogger = consoleOperatorLogger,
    private readonly now: () => number = nowSeconds,
  ) {}

  async processOnce(): Promise<OperatorIterationResult> {
    const now = this.now();
    const match = await reserveNextCrossingMatch(this.prisma, now);
    if (match === null) return { outcome: 'IDLE' };

    let preflight;
    try {
      // This is the single fresh, block-pinned chain check immediately before submit.
      preflight = await this.preflight.check(match);
    } catch (error) {
      const failure = operatorFailure(error);
      const code = `PREFLIGHT_${failure.code}`;
      await this.prisma.settlementMatch.update({
        where: { id: match.id },
        data: {
          status: 'FAILED',
          failureCode: code,
          failureMessage: failure.message,
          updatedAt: now,
        },
      });
      await recordOrderFailure(
        this.prisma,
        match,
        code,
        failure.message,
        now,
      );
      this.logger.warn(`[operator] match=${match.id} failed code=${code}`);
      return {
        outcome: 'FAILED',
        matchId: match.id,
        retryAfterMs: failure.retryAfterMs,
        failureCode: code,
      };
    }

    if (!preflight.ok) {
      await this.prisma.settlementMatch.update({
        where: { id: match.id },
        data: {
          status: 'BLOCKED',
          failureCode: preflight.code,
          failureMessage: preflight.message,
          updatedAt: now,
        },
      });
      await recordOrderFailure(
        this.prisma,
        match,
        preflight.code,
        preflight.message,
        now,
        statusForPreflightFailure(preflight.code),
      );
      this.logger.info(
        `[operator] match=${match.id} blocked code=${preflight.code}`,
      );
      return { outcome: 'BLOCKED', matchId: match.id };
    }

    const claimed = await this.prisma.settlementMatch.updateMany({
      where: { id: match.id, status: 'PENDING' },
      data: {
        status: 'SUBMITTING',
        attemptCount: { increment: 1 },
        updatedAt: now,
      },
    });
    if (claimed.count !== 1) return { outcome: 'SKIPPED', matchId: match.id };

    const transaction = buildCtfExchangeMatchOrdersTx({
      takerOrder: signedOrderFromRow(match.takerOrder),
      makerOrders: [signedOrderFromRow(match.makerOrder)],
      takerFillAmount: BigInt(match.fillSizeRaw),
      makerFillAmounts: [BigInt(match.fillSizeRaw)],
    });
    try {
      const txHash = await this.submitter.submit(transaction);
      await this.prisma.settlementMatch.update({
        where: { id: match.id },
        data: {
          status: 'SUBMITTED',
          txHash: txHash.toLowerCase(),
          failureCode: null,
          failureMessage: null,
          updatedAt: this.now(),
        },
      });
      this.logger.info(`[operator] match=${match.id} submitted tx=${txHash}`);
      return { outcome: 'SUBMITTED', matchId: match.id };
    } catch (error) {
      const failure = operatorFailure(error);
      const failedAt = this.now();
      const submissionStatus = failure.code.startsWith('RPC_')
        ? 'SUBMISSION_UNKNOWN'
        : 'FAILED';
      await this.prisma.settlementMatch.update({
        where: { id: match.id },
        data: {
          status: submissionStatus,
          failureCode: failure.code,
          failureMessage: failure.message,
          updatedAt: failedAt,
        },
      });
      await recordOrderFailure(
        this.prisma,
        match,
        failure.code,
        failure.message,
        failedAt,
      );
      this.logger.warn(
        `[operator] match=${match.id} failed code=${failure.code}`,
      );
      return {
        outcome: 'FAILED',
        matchId: match.id,
        retryAfterMs: failure.retryAfterMs,
        failureCode: failure.code,
      };
    }
  }
}

export function operatorAccountFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LocalAccount {
  if (
    env.OPERATOR_PRIVATE_KEY !== undefined &&
    env.OPERATOR_PRIVATE_KEY_FILE !== undefined
  ) {
    throw new Error(
      'OPERATOR_PRIVATE_KEY and OPERATOR_PRIVATE_KEY_FILE are mutually exclusive',
    );
  }
  const value = env.OPERATOR_PRIVATE_KEY;
  if (value === undefined || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error('OPERATOR_PRIVATE_KEY must be a 32-byte hex key');
  }
  const account = privateKeyToAccount(value as Hex);
  if (!isAddressEqual(account.address, ADDRESSES.ctfExchangeOperator)) {
    throw new Error('OPERATOR_PRIVATE_KEY does not belong to the configured operator');
  }
  return account;
}

export interface OperatorCredentialFileReader {
  lstat(path: string): Promise<{ mode: number; isFile(): boolean }>;
  readFile(path: string): Promise<string>;
}

const nodeOperatorCredentialFileReader: OperatorCredentialFileReader = {
  lstat,
  readFile: (path) => readFile(path, 'utf8'),
};

export async function loadOperatorPrivateKey(
  env: NodeJS.ProcessEnv = process.env,
  reader: OperatorCredentialFileReader = nodeOperatorCredentialFileReader,
): Promise<Hex> {
  const direct = env.OPERATOR_PRIVATE_KEY;
  const configuredPath = env.OPERATOR_PRIVATE_KEY_FILE;
  if (direct !== undefined && configuredPath !== undefined) {
    throw new Error(
      'OPERATOR_PRIVATE_KEY and OPERATOR_PRIVATE_KEY_FILE are mutually exclusive',
    );
  }
  if (direct !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/u.test(direct)) {
      throw new Error('OPERATOR_PRIVATE_KEY must be a 32-byte hex key');
    }
    return direct as Hex;
  }
  const path = configuredPath?.trim();
  if (!path) {
    throw new Error(
      'Set exactly one of OPERATOR_PRIVATE_KEY or OPERATOR_PRIVATE_KEY_FILE',
    );
  }
  const metadata = await reader.lstat(path);
  if (!metadata.isFile()) {
    throw new Error('OPERATOR_PRIVATE_KEY_FILE must refer to a regular file');
  }
  if ((metadata.mode & 0o077) !== 0 || (metadata.mode & 0o400) === 0) {
    throw new Error(
      'OPERATOR_PRIVATE_KEY_FILE must be owner-readable and inaccessible to group/other users',
    );
  }
  const value = (await reader.readFile(path)).trim();
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error('OPERATOR_PRIVATE_KEY_FILE must contain a 32-byte hex key');
  }
  return value as Hex;
}

export async function operatorAccountFromRuntime(
  env: NodeJS.ProcessEnv = process.env,
  reader: OperatorCredentialFileReader = nodeOperatorCredentialFileReader,
): Promise<LocalAccount> {
  const value = await loadOperatorPrivateKey(env, reader);
  const account = privateKeyToAccount(value);
  if (!isAddressEqual(account.address, ADDRESSES.ctfExchangeOperator)) {
    throw new Error('Operator credential does not belong to the configured operator');
  }
  return account;
}

export function createViemSettlementSubmitter(
  account: LocalAccount,
  rpcUrl: string,
): OperatorTransactionSubmitter {
  const walletClient = createWalletClient({
    account,
    chain: ARC_CHAIN,
    transport: http(rpcUrl, { retryCount: 0 }),
  });
  const publicClient = createArcPublicClient([rpcUrl]);
  return {
    submit: (transaction) =>
      walletClient.sendTransaction({
        account,
        chain: ARC_CHAIN,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
      }),
    confirm: async (txHash) => {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
        timeout: 60_000,
      });
      const blockNumber = Number(receipt.blockNumber);
      if (!Number.isSafeInteger(blockNumber)) {
        throw new Error('Confirmed transaction block exceeds the database integer range');
      }
      return { status: receipt.status, blockNumber };
    },
  };
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function runOperatorLoop(
  operator: OperatorLoopWorker,
  options: {
    signal: AbortSignal;
    pollMs: number;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<void> {
  const wait = options.wait ?? abortableWait;
  while (!options.signal.aborted) {
    const result = await operator.processOnce();
    if (options.signal.aborted) break;
    const delay =
      result.outcome === 'FAILED'
        ? Math.max(options.pollMs, result.retryAfterMs ?? options.pollMs)
        : result.outcome === 'PROGRESSED'
          ? 0
          : options.pollMs;
    if (delay > 0) await wait(delay, options.signal);
  }
}
