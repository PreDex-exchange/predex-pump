import { ADDRESSES } from '@predex-pump/shared';
import {
  Side,
  ctfExchangeAbi,
  miniClobAbi,
  type CtfExchangeOrder,
  type TxRequest,
} from '@predex-pump/shared/tx';
import {
  decodeFunctionData,
  zeroHash,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getMarketBook } from '../src/api/queries.js';
import { ViemOrderChainReader } from '../src/orderbook/chain-reader.js';
import type {
  BookMigrationChainReader,
  BookMigrationChainState,
  FreshOrderChainState,
  MiniClobSeedOrderState,
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
import {
  DEPLOYER,
  MARKET_ONE_CONDITION,
  MARKET_ONE_QUESTION,
  seedContractData,
} from './fixtures.js';

const YES_SEED_ID = 20n;
const NO_SEED_ID = 21n;
const YES_TOKEN_ID = 101n;
const NO_TOKEN_ID = 102n;
const TRADING_ENDS_AT = 2_000_086_400n;

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
}): MiniClobSeedOrderState {
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
      registeredTradingEndsAt: yes
        ? this.state.yesRegistration.tradingEndsAt
        : this.state.noRegistration.tradingEndsAt,
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
  | {
      type: 'REGISTER';
      tokenId: bigint;
      complement: bigint;
      conditionId: Hex;
      tradingEndsAt: bigint;
    }
  | { type: 'CUTOVER'; conditionId: Hex };

class FakeMigrationSubmitter implements OperatorTransactionSubmitter {
  approvalSubmissions = 0;
  registrationSubmissions = 0;
  cutoverSubmissions = 0;
  unknownRegistrationOnce = false;
  unknownRegistrationBroadcast = true;
  registrationConfirmationFailureOnce = false;
  registrationRevertOnce = false;
  resolveOnRegistration = false;
  unknownCutoverOnce = false;
  unknownCutoverBroadcast = true;
  cutoverConfirmationFailureOnce = false;
  errorSecret = '';
  private nextHash = 1;
  private readonly actions = new Map<string, SubmittedAction>();

  constructor(private readonly state: BookMigrationChainState) {}

  get cancelSubmissions(): number {
    return this.cutoverSubmissions;
  }

  async submit(transaction: TxRequest): Promise<Hex> {
    const action = this.action(transaction);
    if (action.type === 'APPROVE') {
      this.approvalSubmissions += 1;
    } else if (action.type === 'REGISTER') {
      this.registrationSubmissions += 1;
      if (this.unknownRegistrationOnce) {
        this.unknownRegistrationOnce = false;
        if (this.unknownRegistrationBroadcast) this.apply(action);
        throw Object.assign(
          new Error(`socket hang up during registration ${this.errorSecret}`),
          { code: 'ECONNRESET' },
        );
      }
    } else {
      this.cutoverSubmissions += 1;
      if (this.unknownCutoverOnce) {
        this.unknownCutoverOnce = false;
        if (this.unknownCutoverBroadcast) this.apply(action);
        throw Object.assign(
          new Error(`socket hang up during cutover ${this.errorSecret}`),
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
    if (
      action.type === 'REGISTER' &&
      this.registrationConfirmationFailureOnce
    ) {
      this.registrationConfirmationFailureOnce = false;
      throw Object.assign(new Error('registration receipt unavailable'), {
        code: 'ECONNRESET',
      });
    }
    if (action.type === 'CUTOVER' && this.cutoverConfirmationFailureOnce) {
      this.cutoverConfirmationFailureOnce = false;
      throw Object.assign(new Error('cutover receipt unavailable'), {
        code: 'ECONNRESET',
      });
    }
    if (action.type === 'REGISTER' && this.registrationRevertOnce) {
      this.registrationRevertOnce = false;
      this.actions.delete(txHash);
      return { status: 'reverted', blockNumber: this.state.blockNumber };
    }
    this.apply(action);
    this.actions.delete(txHash);
    return { status: 'success', blockNumber: this.state.blockNumber };
  }

  private action(transaction: TxRequest): SubmittedAction {
    if (transaction.to.toLowerCase() === ADDRESSES.ctf.toLowerCase()) {
      return { type: 'APPROVE' };
    }
    if (transaction.to.toLowerCase() === ADDRESSES.ctfExchange.toLowerCase()) {
      const decoded = decodeFunctionData({
        abi: ctfExchangeAbi,
        data: transaction.data,
      });
      const [tokenId, complement, conditionId, tradingEndsAt] = decoded.args ?? [];
      if (
        decoded.functionName !== 'registerToken' ||
        typeof tokenId !== 'bigint' ||
        typeof complement !== 'bigint' ||
        typeof conditionId !== 'string' ||
        typeof tradingEndsAt !== 'bigint'
      ) {
        throw new Error('unexpected CTFExchange migration transaction');
      }
      return {
        type: 'REGISTER',
        tokenId,
        complement,
        conditionId: conditionId as Hex,
        tradingEndsAt,
      };
    }
    const decoded = decodeFunctionData({
      abi: miniClobAbi,
      data: transaction.data,
    });
    const conditionId = decoded.args?.[0];
    if (decoded.functionName !== 'cutover' || typeof conditionId !== 'string') {
      throw new Error('unexpected migration transaction');
    }
    return { type: 'CUTOVER', conditionId: conditionId as Hex };
  }

  private apply(action: SubmittedAction): void {
    this.state.blockNumber += 1;
    this.state.blockTimestamp += 1n;
    if (action.type === 'APPROVE') {
      this.state.ctfApprovedForAll = true;
      return;
    }
    if (action.type === 'REGISTER') {
      this.state.yesRegistration = {
        complementTokenId: action.complement,
        conditionId: action.conditionId,
        tradingEndsAt: action.tradingEndsAt,
      };
      this.state.noRegistration = {
        complementTokenId: action.tokenId,
        conditionId: action.conditionId,
        tradingEndsAt: action.tradingEndsAt,
      };
      if (this.resolveOnRegistration) this.state.payoutDenominator = 1n;
      return;
    }
    if (action.conditionId.toLowerCase() !== MARKET_ONE_CONDITION.toLowerCase()) {
      throw new Error('unexpected cutover condition');
    }
    for (const order of [this.state.yesOrder, this.state.noOrder]) {
      if (order === null || !order.open) continue;
      order.open = false;
      const recovered = order.sizeRaw - order.filledRaw;
      if (order.tokenId === YES_TOKEN_ID) {
        this.state.yesBalanceRaw += recovered;
      } else {
        this.state.noBalanceRaw += recovered;
      }
    }
    this.state.conditionStale = true;
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
  registration?: 'registered' | 'absent' | 'half' | 'mismatched';
  registrationAuthorized?: boolean;
  registrationEnabled?: boolean;
  zeroHandoff?: boolean;
  stale?: boolean;
} = {}): Promise<Harness> {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const frozenYesPriceRaw = input.frozenYesPriceRaw ?? 600_000n;
  const yesOrder = input.zeroHandoff ? null : seedOrder({
    orderId: YES_SEED_ID,
    maker: account.address,
    tokenId: YES_TOKEN_ID,
    priceRaw: frozenYesPriceRaw,
    ...(input.yes === undefined ? {} : { overrides: input.yes }),
  });
  const noOrder = input.zeroHandoff ? null : seedOrder({
    orderId: NO_SEED_ID,
    maker: account.address,
    tokenId: NO_TOKEN_ID,
    priceRaw: 1_000_000n - frozenYesPriceRaw,
    ...(input.no === undefined ? {} : { overrides: input.no }),
  });
  const yesInitiallyRecovered = yesOrder === null || yesOrder.open
    ? 0n
    : yesOrder.sizeRaw - yesOrder.filledRaw;
  const noInitiallyRecovered = noOrder === null || noOrder.open
    ? 0n
    : noOrder.sizeRaw - noOrder.filledRaw;
  const absentRegistration = {
    complementTokenId: 0n,
    conditionId: zeroHash,
    tradingEndsAt: 0n,
  } as const;
  const registeredYes = {
    complementTokenId: NO_TOKEN_ID,
    conditionId: MARKET_ONE_CONDITION as Hex,
    tradingEndsAt: TRADING_ENDS_AT,
  } as const;
  const registeredNo = {
    complementTokenId: YES_TOKEN_ID,
    conditionId: MARKET_ONE_CONDITION as Hex,
    tradingEndsAt: TRADING_ENDS_AT,
  } as const;
  const registration = input.registration ?? 'absent';
  const state: BookMigrationChainState = {
    blockNumber: 500,
    blockTimestamp: BigInt(BOOK_NOW),
    conditionStale: input.zeroHandoff ? true : (input.stale ?? false),
    graduationSeedOrderIds: {
      yesOrderId: input.zeroHandoff ? 0n : YES_SEED_ID,
      noOrderId: input.zeroHandoff ? 0n : NO_SEED_ID,
    },
    makerNonce: 7n,
    ctfApprovedForAll: input.approved ?? true,
    registrationAuthorized: input.registrationAuthorized ?? true,
    exchangeCtfAddress: ADDRESSES.ctf,
    exchangeCollateralAddress: ADDRESSES.usdc,
    conditionPrepared: true,
    payoutDenominator: 0n,
    yesBalanceRaw: yesInitiallyRecovered,
    noBalanceRaw: noInitiallyRecovered,
    yesRegistration:
      registration === 'absent'
        ? { ...absentRegistration }
        : registration === 'mismatched'
          ? { ...registeredYes, complementTokenId: NO_TOKEN_ID + 1n }
          : { ...registeredYes },
    noRegistration:
      registration === 'absent' || registration === 'half'
        ? { ...absentRegistration }
        : { ...registeredNo },
    registryTradingEndsAt: TRADING_ENDS_AT,
    registryLifecycle: {
      creator: DEPLOYER,
      marketTypeVersion: 2,
      state: 3,
      paused: false,
    },
    registryBinding: {
      collateralAddress: ADDRESSES.usdc,
      ctfAddress: ADDRESSES.ctf,
      oracleAddress: ADDRESSES.oracle,
      questionId: MARKET_ONE_QUESTION as Hex,
      conditionId: MARKET_ONE_CONDITION as Hex,
      yesTokenId: YES_TOKEN_ID,
      noTokenId: NO_TOKEN_ID,
    },
    yesOrder,
    noOrder,
  };
  await testPrisma.order.deleteMany({ where: { marketId: '1' } });
  await testPrisma.market.update({
    where: { id: '1' },
    data: {
      yesSeedOrderId: (input.zeroHandoff ? 0n : YES_SEED_ID).toString(),
      noSeedOrderId: (input.zeroHandoff ? 0n : NO_SEED_ID).toString(),
      frozenYesPriceRaw: frozenYesPriceRaw.toString(),
      yesPriceRaw: frozenYesPriceRaw.toString(),
      noPriceRaw: (1_000_000n - frozenYesPriceRaw).toString(),
      minimumTickSizeRaw: (input.minimumTickSizeRaw ?? 1_000n).toString(),
    },
  });
  if (yesOrder !== null && noOrder !== null) {
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
  }
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
    undefined,
    input.registrationEnabled ?? true,
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

  it('pins every cutover and registration prerequisite to one fresh block', async () => {
    const getChainId = vi.fn(async () => 5_042_002);
    const getBlock = vi.fn(async () => ({
      number: 500n,
      timestamp: BigInt(BOOK_NOW),
    }));
    const multicall = vi.fn(async (_parameters: unknown) => [
      [
        DEPLOYER,
        MARKET_ONE_CONDITION,
        YES_TOKEN_ID,
        BigInt(Side.SELL),
        600_000n,
        5_000_000n,
        0n,
        true,
      ],
      [
        DEPLOYER,
        MARKET_ONE_CONDITION,
        NO_TOKEN_ID,
        BigInt(Side.SELL),
        400_000n,
        5_000_000n,
        0n,
        true,
      ],
      7n,
      true,
      0n,
      0n,
      [NO_TOKEN_ID, MARKET_ONE_CONDITION, TRADING_ENDS_AT],
      [YES_TOKEN_ID, MARKET_ONE_CONDITION, TRADING_ENDS_AT],
      0n,
      [DEPLOYER, 2n, 3n, false],
      [
        ADDRESSES.usdc,
        ADDRESSES.ctf,
        ADDRESSES.oracle,
        MARKET_ONE_QUESTION,
        MARKET_ONE_CONDITION,
        YES_TOKEN_ID,
        NO_TOKEN_ID,
      ],
      true,
      ADDRESSES.ctf,
      ADDRESSES.usdc,
      true,
      false,
      [YES_SEED_ID, NO_SEED_ID],
      TRADING_ENDS_AT,
    ]);
    const reader = new ViemOrderChainReader({
      getChainId,
      getBlock,
      multicall,
    } as unknown as PublicClient);

    await expect(
      reader.readBookMigrationState({
        marketId: 1n,
        maker: DEPLOYER,
        conditionId: MARKET_ONE_CONDITION as Hex,
        yesTokenId: YES_TOKEN_ID,
        noTokenId: NO_TOKEN_ID,
        yesSeedOrderId: YES_SEED_ID,
        noSeedOrderId: NO_SEED_ID,
      }),
    ).resolves.toMatchObject({
      blockNumber: 500,
      conditionPrepared: true,
      conditionStale: false,
      graduationSeedOrderIds: {
        yesOrderId: YES_SEED_ID,
        noOrderId: NO_SEED_ID,
      },
      registrationAuthorized: true,
      exchangeCtfAddress: ADDRESSES.ctf,
      exchangeCollateralAddress: ADDRESSES.usdc,
      registryTradingEndsAt: TRADING_ENDS_AT,
      yesRegistration: { tradingEndsAt: TRADING_ENDS_AT },
      noRegistration: { tradingEndsAt: TRADING_ENDS_AT },
      registryLifecycle: {
        creator: DEPLOYER,
        marketTypeVersion: 2,
        state: 3,
        paused: false,
      },
      registryBinding: {
        conditionId: MARKET_ONE_CONDITION,
        yesTokenId: YES_TOKEN_ID,
        noTokenId: NO_TOKEN_ID,
      },
    });
    expect(getChainId).toHaveBeenCalledOnce();
    expect(getBlock).toHaveBeenCalledWith({ blockTag: 'latest' });
    const request = multicall.mock.calls[0]?.[0] as {
      blockNumber: bigint;
      contracts: Array<{ functionName: string }>;
    };
    expect(request.blockNumber).toBe(500n);
    expect(request.contracts.map(({ functionName }) => functionName)).toEqual([
      'getOrder',
      'getOrder',
      'makerNonce',
      'isApprovedForAll',
      'balanceOf',
      'balanceOf',
      'registry',
      'registry',
      'payoutDenominator',
      'marketLifecycle',
      'tokenBinding',
      'isConditionPrepared',
      'ctf',
      'collateral',
      'hasRole',
      'conditionStale',
      'graduationSeedOrderIds',
      'marketTradingEndsAt',
    ]);
  });

  it('pins zero-handoff cutover state without calling getOrder(0)', async () => {
    const multicall = vi.fn(async (_parameters: unknown) => [
      7n,
      false,
      0n,
      0n,
      [0n, zeroHash, 0n],
      [0n, zeroHash, 0n],
      0n,
      [DEPLOYER, 2n, 3n, false],
      [
        ADDRESSES.usdc,
        ADDRESSES.ctf,
        ADDRESSES.oracle,
        MARKET_ONE_QUESTION,
        MARKET_ONE_CONDITION,
        YES_TOKEN_ID,
        NO_TOKEN_ID,
      ],
      true,
      ADDRESSES.ctf,
      ADDRESSES.usdc,
      true,
      true,
      [0n, 0n],
      TRADING_ENDS_AT,
    ]);
    const reader = new ViemOrderChainReader({
      getChainId: vi.fn(async () => 5_042_002),
      getBlock: vi.fn(async () => ({
        number: 500n,
        timestamp: BigInt(BOOK_NOW),
      })),
      multicall,
    } as unknown as PublicClient);

    await expect(
      reader.readBookMigrationState({
        marketId: 1n,
        maker: DEPLOYER,
        conditionId: MARKET_ONE_CONDITION as Hex,
        yesTokenId: YES_TOKEN_ID,
        noTokenId: NO_TOKEN_ID,
        yesSeedOrderId: 0n,
        noSeedOrderId: 0n,
      }),
    ).resolves.toMatchObject({
      conditionStale: true,
      yesOrder: null,
      noOrder: null,
      graduationSeedOrderIds: { yesOrderId: 0n, noOrderId: 0n },
    });
    const request = multicall.mock.calls[0]?.[0] as {
      contracts: Array<{ functionName: string }>;
    };
    expect(
      request.contracts.some(({ functionName }) => functionName === 'getOrder'),
    ).toBe(false);
  });

  it('cuts over first, then stages and activates both complementary replacements', async () => {
    const harness = await createHarness();
    const before = await getMarketBook(testPrisma, '1');
    expect(before?.liveVenue).toBe('MINICLOB');
    expect(before?.yes.asks).toEqual([
      { priceRaw: '600000', sizeRaw: '5000000', orderCount: 1 },
    ]);

    await step(harness);
    expect(await testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }))
      .toMatchObject({ status: 'CANCELLED' });
    expect(harness.submitter.cutoverSubmissions).toBe(1);
    expect(harness.submitter.registrationSubmissions).toBe(0);

    await step(harness);
    expect(await testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }))
      .toMatchObject({ status: 'STAGED' });
    expect(
      await testPrisma.signedOrder.findMany({ select: { status: true } }),
    ).toEqual([{ status: 'STAGED' }, { status: 'STAGED' }]);
    expect(harness.submitter.registrationSubmissions).toBe(0);

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
    expect(replacements.map(({ expiration }) => expiration)).toEqual([
      Number(TRADING_ENDS_AT),
      Number(TRADING_ENDS_AT),
    ]);
    const after = await getMarketBook(testPrisma, '1');
    expect(after?.liveVenue).toBe('HYBRID');
    expect(after?.yes.orders).toEqual([]);
    expect(after?.yes.offchainOrders).toHaveLength(1);
    expect(after?.no.offchainOrders).toHaveLength(1);
    expect(harness.submitter.cutoverSubmissions).toBe(1);
    expect(harness.submitter.registrationSubmissions).toBe(1);
  });

  it('cuts over, recovers, registers, and migrates without replacements after the deadline', async () => {
    const harness = await createHarness({ approved: false });
    harness.state.blockTimestamp = TRADING_ENDS_AT;

    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'PROGRESSED',
      marketId: '1',
    });
    expect(harness.submitter.cutoverSubmissions).toBe(1);
    expect(harness.submitter.registrationSubmissions).toBe(0);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({ status: 'CANCELLED' });

    await runToStatus(harness, 'MIGRATED');

    expect(harness.submitter.cutoverSubmissions).toBe(1);
    expect(harness.submitter.approvalSubmissions).toBe(0);
    expect(harness.submitter.registrationSubmissions).toBe(1);
    expect(await testPrisma.signedOrder.count()).toBe(0);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'MIGRATED',
      registrationStatus: 'CONFIRMED',
      yesReplacementOrderHash: null,
      noReplacementOrderHash: null,
      yesReplacementSizeRaw: '0',
      noReplacementSizeRaw: '0',
      yesRecoveredRaw: '5000000',
      noRecoveredRaw: '5000000',
      yesUnquotedRemainderRaw: '5000000',
      noUnquotedRemainderRaw: '5000000',
      yesRealizedPriceRaw: null,
      noRealizedPriceRaw: null,
    });
  });

  it('recovers an ended market before waiting for disabled registration', async () => {
    const harness = await createHarness({
      approved: false,
      registrationEnabled: false,
    });
    harness.state.blockTimestamp = TRADING_ENDS_AT;

    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'PROGRESSED',
      marketId: '1',
    });
    expect(harness.submitter.cutoverSubmissions).toBe(1);
    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'PROGRESSED',
      marketId: '1',
    });
    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'REGISTRATION_DISABLED',
    });

    expect(harness.submitter.registrationSubmissions).toBe(0);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'STAGED',
      yesRecoveredRaw: '5000000',
      noRecoveredRaw: '5000000',
      yesReplacementOrderHash: null,
      noReplacementOrderHash: null,
      lastFailureCode: 'REGISTRATION_DISABLED',
      migratedAt: null,
    });
  });

  it('expires staged replacements if the deadline arrives before publication', async () => {
    const harness = await createHarness({ approved: false });
    await runToStatus(harness, 'STAGED');
    expect(
      await testPrisma.signedOrder.count({ where: { status: 'STAGED' } }),
    ).toBe(2);

    harness.state.blockTimestamp = TRADING_ENDS_AT;
    await runToStatus(harness, 'MIGRATED');

    expect(harness.submitter.approvalSubmissions).toBe(0);
    expect(harness.submitter.registrationSubmissions).toBe(1);
    expect(
      await testPrisma.signedOrder.findMany({
        select: { status: true },
        orderBy: { outcome: 'asc' },
      }),
    ).toEqual([{ status: 'EXPIRED' }, { status: 'EXPIRED' }]);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'MIGRATED',
      yesReplacementOrderHash: null,
      noReplacementOrderHash: null,
      yesReplacementSizeRaw: '0',
      noReplacementSizeRaw: '0',
      yesUnquotedRemainderRaw: '5000000',
      noUnquotedRemainderRaw: '5000000',
    });
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

  it('requires the authorized cutover even when both seed asks were fully filled', async () => {
    const harness = await createHarness({
      yes: { sizeRaw: 5_000_000n, filledRaw: 5_000_000n, open: false },
      no: { sizeRaw: 5_000_000n, filledRaw: 5_000_000n, open: false },
    });

    await runToStatus(harness, 'MIGRATED');
    expect(harness.submitter.cutoverSubmissions).toBe(1);
    expect(harness.submitter.registrationSubmissions).toBe(1);
    expect(
      await testPrisma.signedOrder.count({
        where: { origin: 'BOOK_MIGRATION', status: 'OPEN' },
      }),
    ).toBe(0);
  });

  it('handles a zero-handoff condition without reading or approving seed orders', async () => {
    const harness = await createHarness({ zeroHandoff: true, approved: false });

    await runToStatus(harness, 'MIGRATED');
    expect(harness.submitter.cutoverSubmissions).toBe(0);
    expect(harness.submitter.approvalSubmissions).toBe(0);
    expect(harness.submitter.registrationSubmissions).toBe(1);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'MIGRATED',
      yesSeedOrderId: '0',
      noSeedOrderId: '0',
      yesReplacementSizeRaw: '0',
      noReplacementSizeRaw: '0',
    });
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
    ).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(harness.reader.migrationReads).toBe(2);
    expect(harness.submitter.cutoverSubmissions).toBe(1);
  });

  it('self-heals an exact pre-registration by cutting over without registering again', async () => {
    const harness = await createHarness({
      registration: 'registered',
      registrationAuthorized: false,
      registrationEnabled: false,
    });

    await runToStatus(harness, 'MIGRATED');
    expect(harness.submitter.registrationSubmissions).toBe(0);
    expect(harness.submitter.cutoverSubmissions).toBe(1);
  });

  it('accepts an exact existing registration only after authoritative cutover', async () => {
    const harness = await createHarness({
      registration: 'registered',
      stale: true,
      yes: { open: false },
      no: { open: false },
    });

    await runToStatus(harness, 'MIGRATED');
    expect(harness.submitter.cutoverSubmissions).toBe(0);
    expect(harness.submitter.registrationSubmissions).toBe(0);
  });

  it('registers an absent token pair exactly once after cutover and staging', async () => {
    const harness = await createHarness({ registration: 'absent' });

    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'PROGRESSED',
      marketId: '1',
    });
    expect(harness.submitter.cutoverSubmissions).toBe(1);
    expect(harness.submitter.registrationSubmissions).toBe(0);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'CANCELLED',
    });

    await runToStatus(harness, 'PUBLISHING');
    expect(harness.submitter.registrationSubmissions).toBe(1);
    expect(harness.submitter.cutoverSubmissions).toBe(1);
    expect(harness.state.yesRegistration).toEqual({
      complementTokenId: NO_TOKEN_ID,
      conditionId: MARKET_ONE_CONDITION,
      tradingEndsAt: TRADING_ENDS_AT,
    });
    expect(harness.state.noRegistration).toEqual({
      complementTokenId: YES_TOKEN_ID,
      conditionId: MARKET_ONE_CONDITION,
      tradingEndsAt: TRADING_ENDS_AT,
    });

    await runToStatus(harness, 'MIGRATED');
    expect(harness.submitter.registrationSubmissions).toBe(1);
  });

  it('recovers only the legacy unregistered publish failure without another cutover', async () => {
    const harness = await createHarness();
    await runToStatus(harness, 'STAGED');
    const cancellationsBeforeRecovery = harness.submitter.cancelSubmissions;
    harness.state.yesRegistration = {
      complementTokenId: 0n,
      conditionId: zeroHash,
      tradingEndsAt: 0n,
    };
    harness.state.noRegistration = {
      complementTokenId: 0n,
      conditionId: zeroHash,
      tradingEndsAt: 0n,
    };
    await testPrisma.bookMigration.update({
      where: { marketId: '1' },
      data: {
        status: 'STAGED',
        registrationStatus: 'UNCHECKED',
        registrationTxHash: null,
        registrationBlockNumber: null,
        nextAttemptAt: 0,
        claimToken: null,
        claimExpiresAt: null,
        lastFailureCode: 'TOKEN_NOT_REGISTERED',
        lastFailureMessage: 'Legacy publish failure',
        lastFailureAt: BOOK_NOW - 1,
      },
    });

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'PROGRESSED',
    });
    expect(harness.submitter.registrationSubmissions).toBe(1);
    expect(harness.submitter.cancelSubmissions).toBe(
      cancellationsBeforeRecovery,
    );
    await runToStatus(harness, 'MIGRATED');
    expect(harness.submitter.registrationSubmissions).toBe(1);
    expect(harness.submitter.cancelSubmissions).toBe(
      cancellationsBeforeRecovery,
    );
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'MIGRATED',
      registrationStatus: 'CONFIRMED',
      lastFailureCode: null,
    });
  });

  it('leaves unrelated legacy FAILED migrations terminal', async () => {
    const harness = await createHarness();
    await testPrisma.bookMigration.create({
      data: {
        marketId: '1',
        status: 'FAILED',
        yesSeedOrderId: YES_SEED_ID.toString(),
        noSeedOrderId: NO_SEED_ID.toString(),
        lastFailureCode: 'INVALID_SEED',
        lastFailureMessage: 'Unrelated terminal failure',
        lastFailureAt: BOOK_NOW - 1,
        createdAt: BOOK_NOW - 10,
        updatedAt: BOOK_NOW - 1,
      },
    });

    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'IDLE',
    });
    expect(harness.reader.migrationReads).toBe(0);
    expect(harness.submitter.registrationSubmissions).toBe(0);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      lastFailureCode: 'INVALID_SEED',
    });
  });

  it.each(['half', 'mismatched'] as const)(
    'fails closed for a %s token registration without submitting or cutting over',
    async (registration) => {
      const harness = await createHarness({ registration });

      await expect(harness.operator.processOnce()).resolves.toEqual({
        outcome: 'FAILED',
        marketId: '1',
        retryAfterMs: 0,
        failureCode: 'TOKEN_REGISTRATION_MISMATCH',
      });
      expect(harness.submitter.registrationSubmissions).toBe(0);
      expect(harness.submitter.cancelSubmissions).toBe(0);
      await expect(
        testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        lastFailureCode: 'TOKEN_REGISTRATION_MISMATCH',
      });
    },
  );

  it('fails closed when the operator lacks the registration role', async () => {
    const harness = await createHarness({
      registration: 'absent',
      registrationAuthorized: false,
    });

    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'FAILED',
      marketId: '1',
      retryAfterMs: 0,
      failureCode: 'REGISTRATION_UNAUTHORIZED',
    });
    expect(harness.submitter.registrationSubmissions).toBe(0);
    expect(harness.submitter.cutoverSubmissions).toBe(0);
  });

  it('defers an absent registration while testnet auto-registration is disabled', async () => {
    const harness = await createHarness({
      registration: 'absent',
      registrationEnabled: false,
    });

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'REGISTRATION_DISABLED',
    });
    expect(harness.submitter.registrationSubmissions).toBe(0);
    expect(harness.submitter.cutoverSubmissions).toBe(0);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'DISCOVERED',
      lastFailureCode: 'REGISTRATION_DISABLED',
    });
  });

  it('fails closed when the fresh Conditional Tokens condition is unprepared', async () => {
    const harness = await createHarness({ registration: 'absent' });
    harness.state.conditionPrepared = false;

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'CONDITION_NOT_PREPARED',
    });
    expect(harness.submitter.registrationSubmissions).toBe(0);
    expect(harness.submitter.cancelSubmissions).toBe(0);
  });

  it('fails closed when the fresh registry lifecycle is not tradable', async () => {
    const harness = await createHarness({ registration: 'absent' });
    harness.state.registryLifecycle.paused = true;

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'REGISTRY_LIFECYCLE_MISMATCH',
    });
    expect(harness.submitter.registrationSubmissions).toBe(0);
    expect(harness.submitter.cancelSubmissions).toBe(0);
  });

  it('fails closed when the fresh registry token binding differs', async () => {
    const harness = await createHarness({ registration: 'absent' });
    harness.state.registryBinding.yesTokenId += 1n;

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'REGISTRY_BINDING_MISMATCH',
    });
    expect(harness.submitter.registrationSubmissions).toBe(0);
    expect(harness.submitter.cancelSubmissions).toBe(0);
  });

  it('fails closed when the fresh Registry deadline differs from the indexed market', async () => {
    const harness = await createHarness({ registration: 'absent' });
    harness.state.registryTradingEndsAt += 1n;

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'REGISTRY_BINDING_MISMATCH',
    });
    expect(harness.submitter.registrationSubmissions).toBe(0);
    expect(harness.submitter.cutoverSubmissions).toBe(0);
  });

  it('fails closed when the Exchange registration deadline differs from Registry', async () => {
    const harness = await createHarness({ registration: 'registered' });
    harness.state.yesRegistration.tradingEndsAt += 1n;

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'TOKEN_REGISTRATION_MISMATCH',
    });
    expect(harness.submitter.cancelSubmissions).toBe(0);
  });

  it('fails closed when indexed seed ids differ from MiniCLOB graduation state', async () => {
    const harness = await createHarness();
    harness.state.graduationSeedOrderIds.noOrderId += 1n;

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'INVALID_SEED',
    });
    expect(harness.submitter.cutoverSubmissions).toBe(0);
    expect(harness.submitter.registrationSubmissions).toBe(0);
  });

  it('stops safely when resolution races a successful registration', async () => {
    const harness = await createHarness({ registration: 'absent' });
    await runToStatus(harness, 'STAGED');
    harness.submitter.resolveOnRegistration = true;

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'MARKET_RESOLVED',
    });
    expect(harness.submitter.registrationSubmissions).toBe(1);
    expect(harness.submitter.cutoverSubmissions).toBe(1);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({ status: 'FAILED' });
  });

  it('immediately reconciles a landed registration after its submit transport fails', async () => {
    const harness = await createHarness({ registration: 'absent' });
    await runToStatus(harness, 'STAGED');
    harness.submitter.unknownRegistrationOnce = true;

    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'PROGRESSED',
      marketId: '1',
    });
    expect(harness.submitter.registrationSubmissions).toBe(1);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'PUBLISHING',
      registrationStatus: 'CONFIRMED',
      registrationTxHash: null,
      registrationBlockNumber: 502,
    });
  });

  it('reconciles a persisted ambiguous registration from chain state after restart', async () => {
    const harness = await createHarness({ registration: 'absent' });
    await runToStatus(harness, 'STAGED');
    await testPrisma.bookMigration.update({
      where: { marketId: '1' },
      data: {
        status: 'REGISTRATION_SUBMISSION_UNKNOWN',
        registrationStatus: 'SUBMISSION_UNKNOWN',
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: 0,
      },
    });
    harness.state.yesRegistration = {
      complementTokenId: NO_TOKEN_ID,
      conditionId: MARKET_ONE_CONDITION as Hex,
      tradingEndsAt: TRADING_ENDS_AT,
    };
    harness.state.noRegistration = {
      complementTokenId: YES_TOKEN_ID,
      conditionId: MARKET_ONE_CONDITION as Hex,
      tradingEndsAt: TRADING_ENDS_AT,
    };

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
    await expect(restarted.processOnce()).resolves.toEqual({
      outcome: 'PROGRESSED',
      marketId: '1',
    });
    expect(harness.submitter.registrationSubmissions).toBe(0);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'PUBLISHING',
      registrationStatus: 'CONFIRMED',
    });
  });

  it('quarantines an unlanded ambiguous submission until the exact pair appears', async () => {
    const harness = await createHarness({ registration: 'absent' });
    await runToStatus(harness, 'STAGED');
    harness.submitter.unknownRegistrationOnce = true;
    harness.submitter.unknownRegistrationBroadcast = false;

    await harness.operator.processOnce();
    expect(harness.submitter.registrationSubmissions).toBe(1);
    harness.clock.value += 5;
    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'REGISTRATION_OUTCOME_UNKNOWN',
    });
    expect(harness.submitter.registrationSubmissions).toBe(1);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'REGISTRATION_SUBMISSION_UNKNOWN',
      registrationStatus: 'SUBMISSION_UNKNOWN',
      registrationTxHash: null,
    });

    harness.clock.value += 61;
    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'REGISTRATION_OUTCOME_UNKNOWN',
    });
    expect(harness.submitter.registrationSubmissions).toBe(1);

    harness.state.yesRegistration = {
      complementTokenId: NO_TOKEN_ID,
      conditionId: MARKET_ONE_CONDITION as Hex,
      tradingEndsAt: TRADING_ENDS_AT,
    };
    harness.state.noRegistration = {
      complementTokenId: YES_TOKEN_ID,
      conditionId: MARKET_ONE_CONDITION as Hex,
      tradingEndsAt: TRADING_ENDS_AT,
    };
    harness.clock.value += 61;
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
    await expect(restarted.processOnce()).resolves.toEqual({
      outcome: 'PROGRESSED',
      marketId: '1',
    });
    expect(harness.submitter.registrationSubmissions).toBe(1);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'PUBLISHING',
      registrationStatus: 'CONFIRMED',
    });
  });

  it('retains a submitted registration hash across receipt failure and restart', async () => {
    const harness = await createHarness({ registration: 'absent' });
    await runToStatus(harness, 'STAGED');
    harness.submitter.registrationConfirmationFailureOnce = true;

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'REGISTRATION_CONFIRMATION_PENDING',
    });
    const submitted = await testPrisma.bookMigration.findUniqueOrThrow({
      where: { marketId: '1' },
    });
    expect(submitted).toMatchObject({
      status: 'REGISTRATION_SUBMITTED',
      registrationStatus: 'SUBMITTED',
    });
    expect(submitted.registrationTxHash).not.toBeNull();
    expect(harness.submitter.registrationSubmissions).toBe(1);

    harness.clock.value += 5;
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
    expect(harness.submitter.registrationSubmissions).toBe(1);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'PUBLISHING',
      registrationStatus: 'CONFIRMED',
      registrationBlockNumber: 502,
    });
  });

  it('fails terminally when a confirmed registration transaction reverted', async () => {
    const harness = await createHarness({ registration: 'absent' });
    await runToStatus(harness, 'STAGED');
    harness.submitter.registrationRevertOnce = true;

    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'FAILED',
      marketId: '1',
      retryAfterMs: 0,
      failureCode: 'REGISTRATION_REVERTED',
    });
    expect(harness.submitter.registrationSubmissions).toBe(1);
    expect(harness.submitter.cutoverSubmissions).toBe(1);
  });

  it('never attempts registration when the condition is already resolved', async () => {
    const harness = await createHarness({ registration: 'absent' });
    harness.state.payoutDenominator = 1n;

    await expect(harness.operator.processOnce()).resolves.toEqual({
      outcome: 'FAILED',
      marketId: '1',
      retryAfterMs: 0,
      failureCode: 'MARKET_RESOLVED',
    });
    expect(harness.submitter.registrationSubmissions).toBe(0);
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
      undefined,
      true,
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
    expect(harness.submitter.cutoverSubmissions).toBe(1);
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

  it('fails terminally without cutover when the market resolves first', async () => {
    const harness = await createHarness();
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

  it('resumes from the confirmed-cutover checkpoint and publishes after restart', async () => {
    const harness = await createHarness();
    await runToStatus(harness, 'CANCELLED');
    const gapBook = await getMarketBook(testPrisma, '1');
    expect(gapBook).toMatchObject({
      orderBookAvailable: false,
      liveVenue: 'NONE',
      venueTransition: { state: 'PREPARING' },
    });
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
      undefined,
      true,
    );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await restarted.processOnce();
      harness.clock.value += 2;
      const current = await testPrisma.bookMigration.findUnique({
        where: { marketId: '1' },
      });
      if (current?.status === 'MIGRATED') break;
    }
    expect(await testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }))
      .toMatchObject({ status: 'MIGRATED' });
    expect((await getMarketBook(testPrisma, '1'))?.liveVenue).toBe('HYBRID');
  });

  it('re-reads chain state after an ambiguous cutover and never blindly retries it', async () => {
    const harness = await createHarness();
    harness.submitter.unknownCutoverOnce = true;
    await runToStatus(harness, 'CANCEL_SUBMISSION_UNKNOWN');
    expect(harness.submitter.cancelSubmissions).toBe(1);

    harness.clock.value += 61;
    await step(harness);
    expect(harness.submitter.cancelSubmissions).toBe(1);
    expect(await testPrisma.bookMigration.findUnique({ where: { marketId: '1' } }))
      .toMatchObject({ status: 'CANCELLED', yesCancelStatus: 'CONFIRMED' });
    await runToStatus(harness, 'MIGRATED');
  });

  it('retains a submitted cutover hash across receipt failure and restart', async () => {
    const harness = await createHarness();
    harness.submitter.cutoverConfirmationFailureOnce = true;

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'CUTOVER_CONFIRMATION_PENDING',
    });
    const submitted = await testPrisma.bookMigration.findUniqueOrThrow({
      where: { marketId: '1' },
    });
    expect(submitted.status).toBe('CANCEL_SUBMITTED');
    expect(submitted.cutoverTxHash).not.toBeNull();
    expect(harness.submitter.cutoverSubmissions).toBe(1);

    harness.clock.value += 5;
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
    expect(harness.submitter.cutoverSubmissions).toBe(1);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('quarantines an unknown unlanded cutover without resubmitting', async () => {
    const harness = await createHarness();
    harness.submitter.unknownCutoverOnce = true;
    harness.submitter.unknownCutoverBroadcast = false;

    await runToStatus(harness, 'CANCEL_SUBMISSION_UNKNOWN');
    expect(harness.submitter.cutoverSubmissions).toBe(1);
    harness.clock.value += 61;
    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'CUTOVER_OUTCOME_UNKNOWN',
    });
    expect(harness.submitter.cutoverSubmissions).toBe(1);
    await expect(
      testPrisma.bookMigration.findUniqueOrThrow({ where: { marketId: '1' } }),
    ).resolves.toMatchObject({
      status: 'CANCEL_SUBMISSION_UNKNOWN',
      cutoverTxHash: null,
    });
  });

  it('confirms cutover before approval, then approves before registration', async () => {
    const harness = await createHarness({ approved: false });
    await step(harness);
    expect(harness.submitter.approvalSubmissions).toBe(0);
    expect(harness.submitter.cutoverSubmissions).toBe(1);

    await step(harness);
    expect(harness.submitter.approvalSubmissions).toBe(0);
    expect(harness.submitter.registrationSubmissions).toBe(0);

    await step(harness);
    expect(harness.submitter.approvalSubmissions).toBe(1);
    expect(harness.submitter.registrationSubmissions).toBe(0);
    expect(harness.state.ctfApprovedForAll).toBe(true);
    await runToStatus(harness, 'MIGRATED');
  });

  it('derives liveVenue from durable migration state', async () => {
    const harness = await createHarness();
    expect((await getMarketBook(testPrisma, '1'))?.liveVenue).toBe('MINICLOB');
    await runToStatus(harness, 'MIGRATED');
    expect((await getMarketBook(testPrisma, '1'))?.liveVenue).toBe('HYBRID');
  });

  it('never publishes staged Hybrid orders without a fresh stale read', async () => {
    const harness = await createHarness();
    await runToStatus(harness, 'PUBLISHING');
    harness.state.conditionStale = false;

    await expect(harness.operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'MINICLOB_NOT_STALE',
    });
    expect(
      await testPrisma.signedOrder.count({
        where: { origin: 'BOOK_MIGRATION', status: 'OPEN' },
      }),
    ).toBe(0);
    expect((await getMarketBook(testPrisma, '1'))?.liveVenue).toBe('NONE');
  });

  it('never writes key material, signatures, or full signed orders to logs', async () => {
    const harness = await createHarness();
    await runToStatus(harness, 'STAGED');
    const signature = (
      await testPrisma.signedOrder.findFirstOrThrow({
        where: { origin: 'BOOK_MIGRATION' },
        select: { signature: true },
      })
    ).signature;
    harness.submitter.unknownRegistrationOnce = true;
    harness.submitter.unknownRegistrationBroadcast = false;
    harness.submitter.errorSecret = `${harness.privateKey} ${signature}`;
    await runToStatus(harness, 'REGISTRATION_SUBMISSION_UNKNOWN');
    const output = harness.messages.join('\n');
    expect(output).not.toContain(harness.privateKey);
    expect(output).not.toContain(signature);
    expect(output).not.toContain('makerAmount');
  });
});
