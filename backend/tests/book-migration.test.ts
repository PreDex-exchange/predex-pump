import { ADDRESSES } from '@predex-pump/shared';
import {
  Side,
  miniClobAbi,
  type CtfExchangeOrder,
  type TxRequest,
} from '@predex-pump/shared/tx';
import { decodeFunctionData, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';

import { getMarketBook } from '../src/api/queries.js';
import type {
  BookMigrationChainReader,
  BookMigrationChainState,
  FreshOrderChainState,
  OrderChainReader,
} from '../src/orderbook/chain-reader.js';
import { BookMigrationOperator } from '../src/orderbook/migration.js';
import type {
  ConfirmedTransaction,
  OperatorLogger,
  OperatorTransactionSubmitter,
} from '../src/orderbook/operator.js';
import { resetDatabase, testPrisma } from './database.js';
import { BOOK_NOW } from './orderbook-fixtures.js';
import { MARKET_ONE_CONDITION, seedContractData } from './fixtures.js';

const YES_SEED_ID = 20n;
const NO_SEED_ID = 21n;
const YES_TOKEN_ID = 101n;
const NO_TOKEN_ID = 102n;

interface SeedOverrides {
  sizeRaw?: bigint;
  filledRaw?: bigint;
  open?: boolean;
}

function seedOrder(input: {
  orderId: bigint;
  maker: Hex;
  tokenId: bigint;
  priceRaw: bigint;
  overrides?: SeedOverrides;
}): BookMigrationChainState['yesOrder'] {
  const sizeRaw = input.overrides?.sizeRaw ?? 5_000_000n;
  const filledRaw = input.overrides?.filledRaw ?? 0n;
  return {
    orderId: input.orderId,
    maker: input.maker,
    conditionId: MARKET_ONE_CONDITION as Hex,
    tokenId: input.tokenId,
    side: Side.SELL,
    priceRaw: input.priceRaw,
    sizeRaw,
    filledRaw,
    open: input.overrides?.open ?? filledRaw < sizeRaw,
  };
}

class FakeMigrationReader
  implements BookMigrationChainReader, OrderChainReader
{
  migrationReads = 0;
  orderReads = 0;
  transientFailureOnce = false;

  constructor(readonly state: BookMigrationChainState) {}

  async readBookMigrationState(): Promise<BookMigrationChainState> {
    this.migrationReads += 1;
    if (this.transientFailureOnce) {
      this.transientFailureOnce = false;
      throw Object.assign(new Error('temporary RPC outage'), {
        code: 'ECONNRESET',
      });
    }
    return this.state;
  }

  async readOrderState(order: CtfExchangeOrder): Promise<FreshOrderChainState> {
    this.orderReads += 1;
    const yes = order.tokenId === YES_TOKEN_ID;
    return {
      blockNumber: this.state.blockNumber,
      blockTimestamp: this.state.blockTimestamp,
      makerNonce: this.state.makerNonce,
      complementTokenId: yes ? NO_TOKEN_ID : YES_TOKEN_ID,
      registeredConditionId: MARKET_ONE_CONDITION as Hex,
      payoutDenominator: this.state.payoutDenominator,
      makerAssetBalance: yes
        ? this.state.yesBalanceRaw
        : this.state.noBalanceRaw,
      approvalKind: 'CTF_APPROVAL_FOR_ALL',
      collateralAllowance: null,
      ctfApprovedForAll: this.state.ctfApprovedForAll,
    };
  }
}

type SubmittedAction =
  | { type: 'APPROVE' }
  | { type: 'CANCEL'; orderId: bigint };

class FakeMigrationSubmitter implements OperatorTransactionSubmitter {
  approvalSubmissions = 0;
  cancelSubmissions = 0;
  unknownCancelOnce = false;
  unknownCancelBroadcast = true;
  errorSecret = '';
  private nextHash = 1;
  private readonly actions = new Map<string, SubmittedAction>();

  constructor(private readonly state: BookMigrationChainState) {}

  async submit(transaction: TxRequest): Promise<Hex> {
    const action = this.action(transaction);
    if (action.type === 'APPROVE') {
      this.approvalSubmissions += 1;
    } else {
      this.cancelSubmissions += 1;
      if (this.unknownCancelOnce) {
        this.unknownCancelOnce = false;
        if (this.unknownCancelBroadcast) this.apply(action);
        throw Object.assign(
          new Error(`socket hang up ${this.errorSecret}`),
          { code: 'ECONNRESET' },
        );
      }
    }
    const hash = `0x${this.nextHash.toString(16).padStart(64, '0')}` as Hex;
    this.nextHash += 1;
    this.actions.set(hash, action);
    return hash;
  }

  async confirm(txHash: Hex): Promise<ConfirmedTransaction> {
    const action = this.actions.get(txHash);
    if (action === undefined) throw new Error('unknown test transaction');
    this.apply(action);
    this.actions.delete(txHash);
    return { status: 'success', blockNumber: this.state.blockNumber };
  }

  private action(transaction: TxRequest): SubmittedAction {
    if (transaction.to.toLowerCase() === ADDRESSES.ctf.toLowerCase()) {
      return { type: 'APPROVE' };
    }
    const decoded = decodeFunctionData({
      abi: miniClobAbi,
      data: transaction.data,
    });
    const orderId = decoded.args?.[0];
    if (decoded.functionName !== 'cancel' || typeof orderId !== 'bigint') {
      throw new Error('unexpected migration transaction');
    }
    return { type: 'CANCEL', orderId };
  }

  private apply(action: SubmittedAction): void {
    this.state.blockNumber += 1;
    this.state.blockTimestamp += 1n;
    if (action.type === 'APPROVE') {
      this.state.ctfApprovedForAll = true;
      return;
    }
    const order =
      action.orderId === this.state.yesOrder.orderId
        ? this.state.yesOrder
        : this.state.noOrder;
    if (!order.open) return;
    order.open = false;
    const recovered = order.sizeRaw - order.filledRaw;
    if (order.tokenId === YES_TOKEN_ID) {
      this.state.yesBalanceRaw += recovered;
    } else {
      this.state.noBalanceRaw += recovered;
    }
  }
}

interface Harness {
  account: ReturnType<typeof privateKeyToAccount>;
  privateKey: Hex;
  reader: FakeMigrationReader;
  state: BookMigrationChainState;
  submitter: FakeMigrationSubmitter;
  messages: string[];
  clock: { value: number };
  operator: BookMigrationOperator;
}

async function createHarness(input: {
  yes?: SeedOverrides;
  no?: SeedOverrides;
  approved?: boolean;
  frozenYesPriceRaw?: bigint;
  minimumTickSizeRaw?: bigint;
} = {}): Promise<Harness> {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const frozenYesPriceRaw = input.frozenYesPriceRaw ?? 600_000n;
  const yesOrder = seedOrder({
    orderId: YES_SEED_ID,
    maker: account.address,
    tokenId: YES_TOKEN_ID,
    priceRaw: frozenYesPriceRaw,
    ...(input.yes === undefined ? {} : { overrides: input.yes }),
  });
  const noOrder = seedOrder({
    orderId: NO_SEED_ID,
    maker: account.address,
    tokenId: NO_TOKEN_ID,
    priceRaw: 1_000_000n - frozenYesPriceRaw,
    ...(input.no === undefined ? {} : { overrides: input.no }),
  });
  const yesInitiallyRecovered = yesOrder.open
    ? 0n
    : yesOrder.sizeRaw - yesOrder.filledRaw;
  const noInitiallyRecovered = noOrder.open
    ? 0n
    : noOrder.sizeRaw - noOrder.filledRaw;
  const state: BookMigrationChainState = {
    blockNumber: 500,
    blockTimestamp: BigInt(BOOK_NOW),
    makerNonce: 7n,
    ctfApprovedForAll: input.approved ?? true,
    payoutDenominator: 0n,
    yesBalanceRaw: yesInitiallyRecovered,
    noBalanceRaw: noInitiallyRecovered,
    yesRegistration: {
      complementTokenId: NO_TOKEN_ID,
      conditionId: MARKET_ONE_CONDITION as Hex,
    },
    noRegistration: {
      complementTokenId: YES_TOKEN_ID,
      conditionId: MARKET_ONE_CONDITION as Hex,
    },
    yesOrder,
    noOrder,
  };
  await testPrisma.order.deleteMany({ where: { marketId: '1' } });
  await testPrisma.market.update({
    where: { id: '1' },
    data: {
      yesSeedOrderId: YES_SEED_ID.toString(),
      noSeedOrderId: NO_SEED_ID.toString(),
      frozenYesPriceRaw: frozenYesPriceRaw.toString(),
      yesPriceRaw: frozenYesPriceRaw.toString(),
      noPriceRaw: (1_000_000n - frozenYesPriceRaw).toString(),
      minimumTickSizeRaw: (input.minimumTickSizeRaw ?? 1_000n).toString(),
    },
  });
  await testPrisma.order.createMany({
    data: [yesOrder, noOrder].map((order, index) => ({
      orderId: order.orderId.toString(),
      marketId: '1',
      conditionId: MARKET_ONE_CONDITION,
      tokenId: order.tokenId.toString(),
      outcome: index === 0 ? 'YES' : 'NO',
      maker: account.address.toLowerCase(),
      side: 'ASK',
      priceRaw: order.priceRaw.toString(),
      sizeRaw: order.sizeRaw.toString(),
      escrowRaw: (order.sizeRaw - order.filledRaw).toString(),
      filledRaw: order.filledRaw.toString(),
      remainingRaw: (order.sizeRaw - order.filledRaw).toString(),
      open: order.open,
      isSeed: true,
      txHash: `0x${(index + 20).toString(16).padStart(64, '0')}`,
      logIndex: index,
      blockNumber: 490,
      createdAt: BOOK_NOW - 100,
      updatedAt: BOOK_NOW - 100,
    })),
  });
  const reader = new FakeMigrationReader(state);
  const submitter = new FakeMigrationSubmitter(state);
  const messages: string[] = [];
  const logger: OperatorLogger = {
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
  };
  const clock = { value: BOOK_NOW };
  const operator = new BookMigrationOperator(
    testPrisma,
    reader,
    submitter,
    account,
    logger,
    () => clock.value,
  );
  return {
    account,
    privateKey,
    reader,
    state,
    submitter,
    messages,
    clock,
    operator,
  };
}

async function step(harness: Harness): Promise<void> {
  await harness.operator.processOnce();
  harness.clock.value += 2;
}

async function runToStatus(
  harness: Harness,
  expected: string,
  maximumSteps = 20,
): Promise<void> {
  for (let attempt = 0; attempt < maximumSteps; attempt += 1) {
    const migration = await testPrisma.bookMigration.findUnique({
      where: { marketId: '1' },
    });
    if (migration?.status === expected) return;
    await step(harness);
  }
  const migration = await testPrisma.bookMigration.findUnique({
    where: { marketId: '1' },
  });
  throw new Error(`migration stopped at ${migration?.status ?? 'missing'}`);
}

describe('graduated book migration', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedContractData();
  });

  it('stages first, migrates both unfilled seeds at complementary prices, and flips venue', async () => {
    const harness = await createHarness();
    const before = await getMarketBook(testPrisma, '1');
    expect(before?.liveVenue).toBe('MINICLOB');
    expect(before?.yes.asks).toEqual([
      { priceRaw: '600000', sizeRaw: '5000000', orderCount: 1 },
    ]);

    await step(harness);
    expect(await testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }))
      .toMatchObject({ status: 'STAGED' });
    expect(
      await testPrisma.signedOrder.findMany({ select: { status: true } }),
    ).toEqual([{ status: 'STAGED' }, { status: 'STAGED' }]);
    expect(harness.submitter.cancelSubmissions).toBe(0);

    await runToStatus(harness, 'MIGRATED');
    const replacements = await testPrisma.signedOrder.findMany({
      where: { origin: 'BOOK_MIGRATION', status: 'OPEN' },
      orderBy: { outcome: 'asc' },
    });
    expect(replacements.map((order) => [order.outcome, order.priceRaw, order.sizeRaw]))
      .toEqual([
        ['NO', '400000', '5000000'],
        ['YES', '600000', '5000000'],
      ]);
    expect(
      BigInt(replacements[0]?.priceRaw ?? '0') +
        BigInt(replacements[1]?.priceRaw ?? '0'),
    ).toBe(1_000_000n);
    const after = await getMarketBook(testPrisma, '1');
    expect(after?.liveVenue).toBe('HYBRID');
    expect(after?.yes.orders).toEqual([]);
    expect(after?.yes.offchainOrders).toHaveLength(1);
    expect(after?.no.offchainOrders).toHaveLength(1);
  });

  it('floors awkward partial-fill remainders to the representable size quantum', async () => {
    const harness = await createHarness({
      yes: { sizeRaw: 5_000_000n, filledRaw: 1_234_567n },
      no: { sizeRaw: 5_000_000n, filledRaw: 2_345_678n },
    });
    await runToStatus(harness, 'MIGRATED');
    const replacements = await testPrisma.signedOrder.findMany({
      where: { origin: 'BOOK_MIGRATION', status: 'OPEN' },
      orderBy: { outcome: 'asc' },
    });
    expect(replacements.map((order) => [order.outcome, order.sizeRaw])).toEqual([
      ['NO', '2654000'],
      ['YES', '3765000'],
    ]);
    expect(replacements.map((order) => order.priceRaw)).toEqual([
      '400000',
      '600000',
    ]);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      yesSnapshotRemainingRaw: '3765433',
      noSnapshotRemainingRaw: '2654322',
      yesReplacementSizeRaw: '3765000',
      noReplacementSizeRaw: '2654000',
      yesUnquotedRemainderRaw: '433',
      noUnquotedRemainderRaw: '322',
    });
  });

  it('quantizes the frozen YES ask upward, keeps complementary prices, and records deviations', async () => {
    const harness = await createHarness({
      frozenYesPriceRaw: 517_321n,
      minimumTickSizeRaw: 1_000n,
      yes: { sizeRaw: 900_000n, filledRaw: 449_877n },
      no: { sizeRaw: 900_000n, filledRaw: 449_877n },
    });

    await runToStatus(harness, 'MIGRATED');
    const replacements = await testPrisma.signedOrder.findMany({
      where: { origin: 'BOOK_MIGRATION', status: 'OPEN' },
      orderBy: { outcome: 'asc' },
    });
    expect(replacements.map((order) => [order.outcome, order.priceRaw, order.sizeRaw]))
      .toEqual([
        ['NO', '482000', '450000'],
        ['YES', '518000', '450000'],
      ]);
    expect(BigInt(replacements[0]!.priceRaw) + BigInt(replacements[1]!.priceRaw))
      .toBe(1_000_000n);
    expect(BigInt(replacements[1]!.priceRaw)).toBeGreaterThanOrEqual(517_321n);

    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      minimumTickSizeRaw: '1000',
      yesPriceRaw: '517321',
      noPriceRaw: '482679',
      yesRealizedPriceRaw: '518000',
      noRealizedPriceRaw: '482000',
      yesPriceDeviationRaw: '679',
      noPriceDeviationRaw: '-679',
      yesReplacementSizeRaw: '450000',
      noReplacementSizeRaw: '450000',
      yesUnquotedRemainderRaw: '123',
      noUnquotedRemainderRaw: '123',
    });
  });

  it('does not create a zero-size replacement when one side is fully filled', async () => {
    const harness = await createHarness({
      yes: { sizeRaw: 5_000_000n, filledRaw: 5_000_000n, open: false },
    });
    await runToStatus(harness, 'MIGRATED');
    const replacements = await testPrisma.signedOrder.findMany({
      where: { origin: 'BOOK_MIGRATION', status: 'OPEN' },
    });
    expect(replacements).toHaveLength(1);
    expect(replacements[0]).toMatchObject({ outcome: 'NO', sizeRaw: '5000000' });
    expect(harness.submitter.cancelSubmissions).toBe(1);
  });

  it('never detects a resolved graduated market with an open seed', async () => {
    const harness = await createHarness();
    await testPrisma.resolution.create({
      data: {
        marketId: '1',
        conditionId: MARKET_ONE_CONDITION,
        outcome: 'YES',
        payoutYes: 1,
        payoutNo: 0,
        denominator: 1,
        resolvedAt: BOOK_NOW - 1,
        txHash: `0x${'c'.repeat(64)}`,
        logIndex: 1,
      },
    });

    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'IDLE',
    });
    await expect(
      testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }),
    ).resolves.toBeNull();
    expect(harness.reader.migrationReads).toBe(0);
    expect(harness.submitter.cancelSubmissions).toBe(0);
  });

  it('still detects an unresolved graduated market with an open seed', async () => {
    const harness = await createHarness();

    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'PROGRESSED',
      marketId: '1',
    });
    await expect(
      testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({ status: 'STAGED' });
    expect(harness.reader.migrationReads).toBe(1);
    expect(harness.submitter.cancelSubmissions).toBe(0);
  });

  it('never detects or migrates an already-migrated market again', async () => {
    const harness = await createHarness();
    await testPrisma.bookMigration.create({
      data: {
        marketId: '1',
        status: 'MIGRATED',
        yesSeedOrderId: YES_SEED_ID.toString(),
        noSeedOrderId: NO_SEED_ID.toString(),
        createdAt: BOOK_NOW - 10,
        updatedAt: BOOK_NOW - 1,
        migratedAt: BOOK_NOW - 1,
      },
    });
    await expect(harness.operator.processOnce()).resolves.toEqual({ outcome: 'IDLE' });
    expect(harness.reader.migrationReads).toBe(0);
    expect(harness.submitter.cancelSubmissions).toBe(0);
  });

  it('uses a compare-and-set lease so two workers cannot migrate the same market', async () => {
    const harness = await createHarness();
    const second = new BookMigrationOperator(
      testPrisma,
      harness.reader,
      harness.submitter,
      harness.account,
      {
        info: (message) => harness.messages.push(message),
        warn: (message) => harness.messages.push(message),
      },
      () => harness.clock.value,
    );
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await Promise.all([
        harness.operator.processOnce(),
        second.processOnce(),
      ]);
      harness.clock.value += 2;
      const migration = await testPrisma.bookMigration.findUnique({
        where: { marketId: '1' },
      });
      if (migration?.status === 'MIGRATED') break;
    }
    expect(await testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }))
      .toMatchObject({ status: 'MIGRATED' });
    expect(harness.submitter.cancelSubmissions).toBe(2);
    expect(
      await testPrisma.signedOrder.count({
        where: { origin: 'BOOK_MIGRATION', status: 'OPEN' },
      }),
    ).toBe(2);
  });

  it('backs off after a transient RPC failure and resumes without crashing', async () => {
    const harness = await createHarness();
    harness.reader.transientFailureOnce = true;
    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'READ_RPC_TRANSIENT',
    });
    expect(await testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }))
      .toMatchObject({ status: 'DISCOVERED', lastFailureCode: 'READ_RPC_TRANSIENT' });
    expect(harness.submitter.cancelSubmissions).toBe(0);
    harness.clock.value += 5;
    await runToStatus(harness, 'MIGRATED');
  });

  it('fails terminally without cancelling when the market resolves before cancellation', async () => {
    const harness = await createHarness();
    await runToStatus(harness, 'CANCELLING');
    expect(harness.submitter.cancelSubmissions).toBe(0);

    harness.state.payoutDenominator = 1n;
    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'FAILED',
      marketId: '1',
      retryAfterMs: 0,
      failureCode: 'MARKET_RESOLVED',
    });
    await expect(
      testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      lastFailureCode: 'MARKET_RESOLVED',
      migratedAt: null,
    });
    expect(harness.submitter.cancelSubmissions).toBe(0);

    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'IDLE',
    });
    expect(
      await testPrisma.bookMigration.count({ where: { marketId: '1' } }),
    ).toBe(1);
    expect(harness.submitter.cancelSubmissions).toBe(0);
  });

  it('resumes from the confirmed-cancel checkpoint and publishes after restart', async () => {
    const harness = await createHarness();
    await runToStatus(harness, 'CANCELLED');
    const gapBook = await getMarketBook(testPrisma, '1');
    expect(gapBook?.liveVenue).toBe('MINICLOB');
    expect(gapBook?.yes.asks).toEqual([]);
    expect(gapBook?.no.asks).toEqual([]);

    const restarted = new BookMigrationOperator(
      testPrisma,
      harness.reader,
      harness.submitter,
      harness.account,
      {
        info: (message) => harness.messages.push(message),
        warn: (message) => harness.messages.push(message),
      },
      () => harness.clock.value,
    );
    await expect(restarted.processOnce()).resolves.toMatchObject({
      outcome: 'PROGRESSED',
    });
    expect(await testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }))
      .toMatchObject({ status: 'MIGRATED' });
    expect((await getMarketBook(testPrisma, '1'))?.liveVenue).toBe('HYBRID');
  });

  it('re-reads chain state after an ambiguous cancel and never blindly retries it', async () => {
    const harness = await createHarness();
    harness.submitter.unknownCancelOnce = true;
    await runToStatus(harness, 'CANCEL_SUBMISSION_UNKNOWN');
    expect(harness.submitter.cancelSubmissions).toBe(1);

    await step(harness);
    expect(harness.submitter.cancelSubmissions).toBe(1);
    expect(await testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }))
      .toMatchObject({ status: 'CANCELLING', yesCancelStatus: 'CONFIRMED' });
    await runToStatus(harness, 'MIGRATED');
  });

  it('detects missing CTF approval and confirms it before cancelling or publishing', async () => {
    const harness = await createHarness({ approved: false });
    await step(harness);
    expect(harness.submitter.approvalSubmissions).toBe(0);
    expect(harness.submitter.cancelSubmissions).toBe(0);

    await step(harness);
    expect(harness.submitter.approvalSubmissions).toBe(1);
    expect(harness.submitter.cancelSubmissions).toBe(0);
    expect(harness.state.ctfApprovedForAll).toBe(true);
    await runToStatus(harness, 'MIGRATED');
  });

  it('derives liveVenue from durable migration state', async () => {
    const harness = await createHarness();
    expect((await getMarketBook(testPrisma, '1'))?.liveVenue).toBe('MINICLOB');
    await runToStatus(harness, 'MIGRATED');
    expect((await getMarketBook(testPrisma, '1'))?.liveVenue).toBe('HYBRID');
  });

  it('never writes key material, signatures, or full signed orders to logs', async () => {
    const harness = await createHarness();
    await step(harness);
    const signature = (
      await testPrisma.signedOrder.findFirstOrThrow({
        where: { origin: 'BOOK_MIGRATION' },
        select: { signature: true },
      })
    ).signature;
    harness.submitter.unknownCancelOnce = true;
    harness.submitter.errorSecret = `${harness.privateKey} ${signature}`;
    await runToStatus(harness, 'CANCEL_SUBMISSION_UNKNOWN');
    const output = harness.messages.join('\n');
    expect(output).not.toContain(harness.privateKey);
    expect(output).not.toContain(signature);
    expect(output).not.toContain('makerAmount');
  });
});
