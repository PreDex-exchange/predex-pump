import type {
  AccountResponse,
  Address,
  Market,
  MarketBookResponse,
  OffchainOrder,
  Order,
  TruthSignalResponse,
} from '@predex-pump/shared';
import {
  buildCtfExchangeOrder,
  ctfExchangeOrderToWire,
  hashCtfExchangeOrder,
  Side,
} from '@predex-pump/shared/tx';
import { describe, expect, it, vi } from 'vitest';

import {
  BroadcastUncertainError,
  runTraderLoop,
  TraderAgent,
  type TraderAgentOptions,
  type TraderDataClient,
  type TraderExecutor,
  type HybridTraderExecutor,
} from '../src/agent.js';
import type {
  TraderLogEntry,
  TraderLogger,
} from '../src/logger.js';

const TRADER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address;
const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const BOOK = '0xdddddddddddddddddddddddddddddddddddddddd' as Address;
const SECRET_SIGNATURE = `0x${'9a'.repeat(65)}` as const;

type AvailableMarketBookResponse = Extract<
  MarketBookResponse,
  { orderBookAvailable: true }
>;

class MemoryLogger implements TraderLogger {
  readonly entries: TraderLogEntry[] = [];

  write(entry: TraderLogEntry): void {
    this.entries.push(entry);
  }
}

function market(
  id = '1',
  overrides: Partial<Market> = {},
): Market {
  return {
    id,
    creator: MAKER,
    question: `Market ${id}?`,
    phase: 'Graduated',
    conditionId: `0x${id.padStart(64, '0')}`,
    questionId: `0x${'f'.repeat(64)}`,
    yesTokenId: `${id}01`,
    noTokenId: `${id}02`,
    seedRaw: '1000000',
    yesPriceRaw: '600000',
    noPriceRaw: '400000',
    graduationActivityRaw: '25000000',
    bookAddress: BOOK,
    frozenYesPriceRaw: '600000',
    handoffSizeRaw: '1000000',
    tradeCount: 2,
    volumeRaw: '1000000',
    params: {
      seedFloorRaw: '1',
      seedCapRaw: '10000000',
      fCapRaw: '10000000',
      graduationMoneyInThresholdRaw: '1000000',
      graduationTollRaw: '1',
      inventoryTargetRaw: '1000000',
      protocolFeeBps: 100,
      depthFeeBps: 50,
      tradingWindowSeconds: 3600,
      minimumTimeOpenSeconds: 60,
      minimumTickSizeRaw: '1000',
    },
    createdAt: 100,
    tradingEndsAt: 2_000,
    graduatedAt: 150,
    resolvedAt: null,
    ...overrides,
  };
}

function order(
  overrides: Partial<Order> = {},
): Order {
  return {
    orderId: '7',
    marketId: '1',
    conditionId: market().conditionId,
    tokenId: market().yesTokenId,
    outcome: 'YES',
    maker: MAKER,
    side: 'ASK',
    priceRaw: '500000',
    sizeRaw: '500000',
    filledRaw: '0',
    remainingRaw: '500000',
    open: true,
    isSeed: false,
    createdAt: 900,
    updatedAt: 900,
    ...overrides,
  };
}

function book(
  marketValue = market(),
  orders: Order[] = [],
): AvailableMarketBookResponse {
  const yesOrders = orders.filter(({ outcome }) => outcome === 'YES');
  const noOrders = orders.filter(({ outcome }) => outcome === 'NO');
  const yesBids = yesOrders
    .filter(({ side }) => side === 'BID')
    .map((value) => ({
      priceRaw: value.priceRaw,
      sizeRaw: value.remainingRaw,
      orderCount: 1,
    }));
  const yesAsks = yesOrders
    .filter(({ side }) => side === 'ASK')
    .map((value) => ({
      priceRaw: value.priceRaw,
      sizeRaw: value.remainingRaw,
      orderCount: 1,
    }));
  return {
    marketId: marketValue.id,
    minimumTickSizeRaw: marketValue.params.minimumTickSizeRaw,
    minimumTickSizeAppliesTo: 'NEW_ORDERS',
    tradingOpen: true,
    orderBookAvailable: true,
    liveVenue: 'MINICLOB',
    yes: {
      marketId: marketValue.id,
      minimumTickSizeRaw: marketValue.params.minimumTickSizeRaw,
      outcome: 'YES',
      tokenId: marketValue.yesTokenId,
      bids: yesBids,
      asks: yesAsks,
      bestBidRaw: yesBids[0]?.priceRaw ?? null,
      bestAskRaw: yesAsks[0]?.priceRaw ?? null,
      orders: yesOrders,
      offchainOrders: [],
    },
    no: {
      marketId: marketValue.id,
      minimumTickSizeRaw: marketValue.params.minimumTickSizeRaw,
      outcome: 'NO',
      tokenId: marketValue.noTokenId,
      bids: [],
      asks: [],
      bestBidRaw: null,
      bestAskRaw: null,
      orders: noOrders,
      offchainOrders: [],
    },
  };
}

function offchainOrder(
  overrides: Partial<OffchainOrder> = {},
): OffchainOrder {
  const maker = overrides.maker ?? MAKER;
  const exchangeSide = overrides.side === 'BID' ? Side.BUY : Side.SELL;
  const signedOrder = buildCtfExchangeOrder({
    salt: 7n,
    maker,
    tokenId: BigInt(market().yesTokenId),
    side: exchangeSide,
    priceRaw: BigInt(overrides.priceRaw ?? '500000'),
    sizeRaw: BigInt(overrides.sizeRaw ?? '500000'),
    expiration: 2_000_000_000n,
    nonce: 4n,
  });
  const orderHash = hashCtfExchangeOrder(signedOrder);
  return {
    orderHash,
    marketId: '1',
    conditionId: market().conditionId as `0x${string}`,
    tokenId: market().yesTokenId,
    outcome: 'YES',
    maker,
    side: overrides.side ?? 'ASK',
    priceRaw: overrides.priceRaw ?? '500000',
    sizeRaw: overrides.sizeRaw ?? '500000',
    filledRaw: '0',
    remainingRaw: overrides.remainingRaw ?? '500000',
    status: 'OPEN',
    fillable: true,
    unfillableReason: null,
    signedOrder: {
      ...ctfExchangeOrderToWire(signedOrder),
      signature: SECRET_SIGNATURE,
    },
    createdAt: 900,
    updatedAt: overrides.updatedAt ?? 900,
    ...overrides,
  };
}

function hybridBook(
  marketValue = market(),
  orders: OffchainOrder[] = [],
): AvailableMarketBookResponse {
  const response = book(marketValue);
  const yesOrders = orders.filter(({ outcome }) => outcome === 'YES');
  const noOrders = orders.filter(({ outcome }) => outcome === 'NO');
  return {
    ...response,
    liveVenue: 'HYBRID',
    yes: {
      ...response.yes,
      orders: [],
      offchainOrders: yesOrders,
      bids: yesOrders
        .filter(({ side }) => side === 'BID')
        .map((value) => ({
          priceRaw: value.priceRaw,
          sizeRaw: value.remainingRaw,
          orderCount: 1,
        })),
      asks: yesOrders
        .filter(({ side }) => side === 'ASK')
        .map((value) => ({
          priceRaw: value.priceRaw,
          sizeRaw: value.remainingRaw,
          orderCount: 1,
        })),
    },
    no: {
      ...response.no,
      orders: [],
      offchainOrders: noOrders,
    },
  };
}

function account(
  positions: AccountResponse['positions'] = [
    {
      account: TRADER,
      marketId: '1',
      outcome: 'YES',
      qtyRaw: '1000000',
      costBasisRaw: '0',
      costBasisEstimated: true,
      realizedPnlRaw: '0',
      unrealizedPnlRaw: '0',
      updatedAt: 900,
    },
  ],
): AccountResponse {
  return {
    account: {
      address: TRADER,
      firstSeenAt: 1,
      marketsCreated: 0,
      tradeCount: 0,
    },
    positions,
    recentTrades: [],
    pnl: { realizedRaw: '0', unrealizedRaw: '0' },
  };
}

function signal(marketId = '1', fairValueYesRaw = '600000'): TruthSignalResponse {
  return {
    marketId,
    estimateType: 'INDEXED_MARKET_ESTIMATE',
    fairValueYesRaw,
    fairValueNoRaw: (1_000_000n - BigInt(fairValueYesRaw)).toString(),
    inputs: {
      currentImpliedYesRaw: fairValueYesRaw,
      recentPrice: {
        pointsUsed: 0,
        oldestTs: null,
        latestTs: null,
        oldestYesPriceRaw: null,
        latestYesPriceRaw: null,
        changeRaw: '0',
      },
      yesBook: {
        bestBidRaw: null,
        bestAskRaw: null,
        midpointRaw: null,
        bidLiquidityRaw: '0',
        askLiquidityRaw: '0',
        imbalancePpm: null,
      },
      context: {
        phase: 'Graduated',
        tradeCount: 0,
        volumeRaw: '0',
      },
    },
    derivation: {
      method: 'INDEXED_MARKET_MICROSTRUCTURE_V1',
      formula: 'fixture',
      currentImpliedWeightBps: 7_000,
      bookMidpointWeightBps: 3_000,
      trendWeightBps: 1_000,
      maxAbsTrendAdjustmentRaw: '25000',
      maxAbsImbalanceAdjustmentRaw: '15000',
      baseRaw: fairValueYesRaw,
      trendAdjustmentRaw: '0',
      imbalanceAdjustmentRaw: '0',
      unclampedFairValueYesRaw: fairValueYesRaw,
    },
    caveats: [],
  };
}

function dataClient({
  markets = [market()],
  books = new Map([['1', book()]]),
  accountResponse = account(),
}: {
  markets?: Market[];
  books?: Map<string, MarketBookResponse>;
  accountResponse?: AccountResponse;
} = {}): TraderDataClient {
  return {
    listMarkets: vi.fn(async () => ({ items: markets, nextCursor: null })),
    getAccount: vi.fn(async () => accountResponse),
    getOrderBook: vi.fn(async (marketId) => {
      const response = books.get(marketId);
      if (response === undefined) throw new Error(`missing book ${marketId}`);
      return response;
    }),
  };
}

function executor(): TraderExecutor & {
  placeOrder: ReturnType<typeof vi.fn<TraderExecutor['placeOrder']>>;
  fillOrder: ReturnType<typeof vi.fn<TraderExecutor['fillOrder']>>;
  cancelOrder: ReturnType<typeof vi.fn<TraderExecutor['cancelOrder']>>;
} {
  return {
    placeOrder: vi.fn(async () => ({
      txHash: `0x${'1'.repeat(64)}`,
      orderId: '100',
    })),
    fillOrder: vi.fn(async () => ({ txHash: `0x${'2'.repeat(64)}` })),
    cancelOrder: vi.fn(async () => ({ txHash: `0x${'3'.repeat(64)}` })),
  };
}

function hybridExecutor(): HybridTraderExecutor & {
  getMakerOrders: ReturnType<typeof vi.fn<HybridTraderExecutor['getMakerOrders']>>;
  placeOrder: ReturnType<typeof vi.fn<HybridTraderExecutor['placeOrder']>>;
  fillOrder: ReturnType<typeof vi.fn<HybridTraderExecutor['fillOrder']>>;
  withdrawOrder: ReturnType<typeof vi.fn<HybridTraderExecutor['withdrawOrder']>>;
  cancelOrder: ReturnType<typeof vi.fn<HybridTraderExecutor['cancelOrder']>>;
} {
  return {
    getMakerOrders: vi.fn(async () => ({
      orders: [],
      onchainOrders: [],
      offchainWithdrawalIsOnchainCancellation: false,
      warning: 'Withdrawal is off-chain only.',
    })),
    placeOrder: vi.fn(async () => ({
      orderHash: `0x${'4'.repeat(64)}`,
      rejections: [],
    })),
    fillOrder: vi.fn(async () => ({ txHash: `0x${'5'.repeat(64)}` })),
    withdrawOrder: vi.fn(async ({ order: value }) => ({
      order: { ...value, status: 'WITHDRAWN', fillable: false },
      offchainWithdrawalIsOnchainCancellation: false,
      signedOrderMayRemainValidOnchain: true,
      warning: 'Signature remains valid until expiry or cancelOrder.',
      authoritativeCancelOrderTx: {
        to: `0x${'6'.repeat(40)}`,
        data: '0x1234',
        valueRaw: '0',
      },
    })),
    cancelOrder: vi.fn(async () => ({ txHash: `0x${'7'.repeat(64)}` })),
  };
}

function createAgent(
  overrides: Partial<TraderAgentOptions> = {},
): {
  agent: TraderAgent;
  logger: MemoryLogger;
  executor: ReturnType<typeof executor>;
  hybridExecutor: ReturnType<typeof hybridExecutor>;
} {
  const logger = new MemoryLogger();
  const actionExecutor = executor();
  const hybridActionExecutor = hybridExecutor();
  const agent = new TraderAgent({
    dataClient: dataClient(),
    readSignal: vi.fn(async ({ marketId }) => ({
      signal: signal(marketId),
      paymentSpendRaw: 0n,
    })),
    executor: actionExecutor,
    hybridExecutor: hybridActionExecutor,
    logger,
    traderAddress: TRADER,
    quoteSizeRaw: 100_000n,
    takeSizeRaw: 100_000n,
    quoteHalfSpreadRaw: 20_000n,
    takeThresholdRaw: 30_000n,
    repriceThresholdRaw: 10_000n,
    staleQuoteSeconds: 90,
    maxInventoryPerSideRaw: 2_000_000n,
    maxNotionalPerOrderRaw: 1_000_000n,
    maxOrdersInFlight: 4,
    maxSessionSpendRaw: 10_000_000n,
    dryRun: true,
    nowSeconds: () => 1_000,
    ...overrides,
  });
  return {
    agent,
    logger,
    executor: actionExecutor,
    hybridExecutor: hybridActionExecutor,
  };
}

describe('TraderAgent', () => {
  it('quotes both sides around fair value and broadcasts nothing in dry-run', async () => {
    const { agent, logger, executor: actionExecutor } = createAgent();

    await agent.runCycle();

    expect(
      logger.entries
        .filter(({ event, action }) => event === 'dry-run' && action === 'PLACE')
        .map(({ side, priceRaw, sizeRaw }) => ({ side, priceRaw, sizeRaw })),
    ).toEqual([
      { side: 'BID', priceRaw: '580000', sizeRaw: '100000' },
      { side: 'ASK', priceRaw: '620000', sizeRaw: '100000' },
    ]);
    expect(actionExecutor.placeOrder).not.toHaveBeenCalled();
    expect(actionExecutor.fillOrder).not.toHaveBeenCalled();
    expect(actionExecutor.cancelOrder).not.toHaveBeenCalled();
  });

  it('snaps bids down and asks up to the market tick and floors awkward quote sizes', async () => {
    const marketValue = market('1', {
      params: {
        ...market().params,
        minimumTickSizeRaw: '10000',
      },
    });
    const { agent, logger } = createAgent({
      dataClient: dataClient({
        markets: [marketValue],
        books: new Map([['1', book(marketValue)]]),
      }),
      readSignal: vi.fn(async ({ marketId }) => ({
        signal: signal(marketId, '603321'),
        paymentSpendRaw: 0n,
      })),
      quoteSizeRaw: 100_123n,
    });

    await agent.runCycle();

    expect(
      logger.entries
        .filter(({ event, action }) => event === 'dry-run' && action === 'PLACE')
        .map(({ side, priceRaw, sizeRaw }) => ({ side, priceRaw, sizeRaw })),
    ).toEqual([
      { side: 'BID', priceRaw: '580000', sizeRaw: '100000' },
      { side: 'ASK', priceRaw: '630000', sizeRaw: '100000' },
    ]);
  });

  it('refuses inventory-increasing actions at the per-side inventory cap', async () => {
    const { agent, logger } = createAgent({ maxInventoryPerSideRaw: 1_000_000n });

    await agent.runCycle();

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'refused',
        action: 'PLACE',
        side: 'BID',
        reason: expect.stringContaining('max-inventory-per-side cap'),
      }),
    );
  });

  it('refuses every exact quote above the per-order notional cap', async () => {
    const { agent, logger } = createAgent({ maxNotionalPerOrderRaw: 50_000n });

    await agent.runCycle();

    const refusals = logger.entries.filter(
      ({ reason }) => reason?.includes('max-notional-per-order cap') ?? false,
    );
    expect(refusals).toHaveLength(2);
    expect(logger.entries.filter(({ event }) => event === 'dry-run')).toHaveLength(0);
  });

  it('refuses a new quote at the max orders-in-flight cap', async () => {
    const ownBid = order({
      orderId: '8',
      maker: TRADER,
      side: 'BID',
      priceRaw: '580000',
      updatedAt: 999,
    });
    const marketValue = market();
    const { agent, logger } = createAgent({
      dataClient: dataClient({
        markets: [marketValue],
        books: new Map([['1', book(marketValue, [ownBid])]]),
      }),
      maxOrdersInFlight: 1,
    });

    await agent.runCycle();

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'refused',
        action: 'PLACE',
        side: 'ASK',
        reason: expect.stringContaining('max-orders-in-flight cap'),
      }),
    );
  });

  it('accounts for planned actions and refuses crossing the total session spend cap', async () => {
    const { agent, logger } = createAgent({ maxSessionSpendRaw: 100_000n });

    await agent.runCycle();

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'dry-run',
        action: 'PLACE',
        side: 'BID',
        notionalRaw: '58000',
      }),
    );
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'refused',
        action: 'PLACE',
        side: 'ASK',
        reason: expect.stringContaining('max-total-session-spend cap'),
      }),
    );
  });

  it('counts paid truth reads inside the same total session spend cap', async () => {
    const { agent, logger } = createAgent({
      maxSessionSpendRaw: 100_000n,
      readSignal: vi.fn(async ({ marketId, maxPaymentRaw }) => {
        expect(maxPaymentRaw).toBe(100_000n);
        return {
          signal: signal(marketId),
          paymentSpendRaw: 50_000n,
        };
      }),
    });

    await agent.runCycle();

    expect(agent.getSessionSpendRaw()).toBe(50_000n);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'refused',
        side: 'BID',
        reason: expect.stringContaining('max-total-session-spend cap'),
      }),
    );
  });

  it('takes a sufficiently underpriced ASK at the exact configured size', async () => {
    const marketValue = market();
    const cheapAsk = order({ priceRaw: '500000', remainingRaw: '500000' });
    const actionExecutor = executor();
    const { agent, logger } = createAgent({
      dataClient: dataClient({
        markets: [marketValue],
        books: new Map([['1', book(marketValue, [cheapAsk])]]),
      }),
      executor: actionExecutor,
      dryRun: false,
    });

    await agent.runCycle();

    expect(actionExecutor.fillOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        marketId: '1',
        orderId: '7',
        restingSide: 'ASK',
        expectedPriceRaw: 500_000n,
        fillSizeRaw: 100_000n,
      }),
    );
  });

  it('trades populated Hybrid depth even though the MiniCLOB orders array is empty', async () => {
    const marketValue = market();
    const cheapAsk = offchainOrder({ priceRaw: '500000' });
    const arcExecutor = executor();
    const hybridActionExecutor = hybridExecutor();
    const { agent, logger } = createAgent({
      dataClient: dataClient({
        markets: [marketValue],
        books: new Map([['1', hybridBook(marketValue, [cheapAsk])]]),
      }),
      executor: arcExecutor,
      hybridExecutor: hybridActionExecutor,
      dryRun: false,
    });

    await agent.runCycle();

    expect(hybridActionExecutor.fillOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        marketId: '1',
        order: cheapAsk,
        expectedPriceRaw: 500_000n,
        fillSizeRaw: 100_000n,
      }),
    );
    expect(arcExecutor.fillOrder).not.toHaveBeenCalled();
    expect(arcExecutor.placeOrder).not.toHaveBeenCalled();
    const serializedLogs = JSON.stringify(logger.entries);
    expect(serializedLogs).not.toContain(SECRET_SIGNATURE);
    expect(serializedLogs).not.toContain('makerAmountRaw');
    expect(serializedLogs).not.toContain('PREDEX_PRIVATE_KEY');
  });

  it('keeps a MINICLOB market exclusively on the existing Arc executor', async () => {
    const marketValue = market();
    const cheapAsk = order({ priceRaw: '500000' });
    const arcExecutor = executor();
    const hybridActionExecutor = hybridExecutor();
    const { agent } = createAgent({
      dataClient: dataClient({
        markets: [marketValue],
        books: new Map([['1', book(marketValue, [cheapAsk])]]),
      }),
      executor: arcExecutor,
      hybridExecutor: hybridActionExecutor,
      dryRun: false,
    });

    await agent.runCycle();

    expect(arcExecutor.fillOrder).toHaveBeenCalledOnce();
    expect(hybridActionExecutor.fillOrder).not.toHaveBeenCalled();
    expect(hybridActionExecutor.placeOrder).not.toHaveBeenCalled();
    expect(hybridActionExecutor.getMakerOrders).not.toHaveBeenCalled();
  });

  it('counts authenticated Hybrid maker orders in the shared in-flight cap', async () => {
    const marketValue = market();
    const resting = offchainOrder({ maker: TRADER, side: 'BID', priceRaw: '580000' });
    const hybridActionExecutor = hybridExecutor();
    hybridActionExecutor.getMakerOrders.mockResolvedValue({
      orders: [resting],
      onchainOrders: [],
      offchainWithdrawalIsOnchainCancellation: false,
      warning: 'Withdrawal is off-chain only.',
    });
    const { agent, logger } = createAgent({
      dataClient: dataClient({
        markets: [marketValue],
        books: new Map([['1', hybridBook(marketValue)]]),
      }),
      hybridExecutor: hybridActionExecutor,
      dryRun: false,
      maxOrdersInFlight: 1,
    });

    await agent.runCycle();

    expect(hybridActionExecutor.placeOrder).not.toHaveBeenCalled();
    expect(
      logger.entries.filter(
        ({ event, reason }) =>
          event === 'refused' &&
          reason?.includes('max-orders-in-flight cap') === true,
      ),
    ).toHaveLength(2);
  });

  it('does not count an ended market retained order against an active market cap', async () => {
    const endedMarket = market('1', { tradingEndsAt: 2_000 });
    const activeMarket = market('2', { tradingEndsAt: 3_000 });
    const retained = offchainOrder({
      maker: TRADER,
      marketId: '1',
      fillable: false,
      unfillableReason: 'TRADING_ENDED',
    });
    const hybridActionExecutor = hybridExecutor();
    hybridActionExecutor.getMakerOrders.mockResolvedValue({
      orders: [retained],
      onchainOrders: [],
      offchainWithdrawalIsOnchainCancellation: false,
      warning: 'Withdrawal is off-chain only.',
    });
    const { agent } = createAgent({
      dataClient: dataClient({
        markets: [endedMarket, activeMarket],
        books: new Map([
          ['1', { ...hybridBook(endedMarket), tradingOpen: false }],
          ['2', hybridBook(activeMarket)],
        ]),
        accountResponse: account([
          {
            account: TRADER,
            marketId: '2',
            outcome: 'YES',
            qtyRaw: '1000000',
            costBasisRaw: '0',
            costBasisEstimated: true,
            realizedPnlRaw: '0',
            unrealizedPnlRaw: '0',
            updatedAt: 900,
          },
        ]),
      }),
      hybridExecutor: hybridActionExecutor,
      dryRun: false,
      maxOrdersInFlight: 2,
      nowSeconds: () => 2_000,
    });

    await agent.runCycle();

    expect(hybridActionExecutor.placeOrder).toHaveBeenCalledTimes(2);
    expect(hybridActionExecutor.placeOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ marketId: '2', side: 'BID' }),
    );
    expect(hybridActionExecutor.placeOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ marketId: '2', side: 'ASK' }),
    );
  });

  it('fails the placement cap closed when the authenticated Hybrid order read fails', async () => {
    const marketValue = market();
    const hybridActionExecutor = hybridExecutor();
    hybridActionExecutor.getMakerOrders.mockRejectedValue(
      new Error('session service unavailable'),
    );
    const { agent, logger } = createAgent({
      dataClient: dataClient({
        markets: [marketValue],
        books: new Map([['1', hybridBook(marketValue)]]),
      }),
      hybridExecutor: hybridActionExecutor,
      dryRun: false,
    });

    await agent.runCycle();

    expect(hybridActionExecutor.placeOrder).not.toHaveBeenCalled();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'backend-error',
        message: expect.stringContaining('placement cap fails closed'),
      }),
    );
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'refused',
        reason: expect.stringContaining('order snapshot read failed'),
      }),
    );
  });

  it('retires a stale Hybrid quote by free withdraw followed by per-order on-chain cancel', async () => {
    const marketValue = market();
    const stale = offchainOrder({
      maker: TRADER,
      side: 'BID',
      priceRaw: '500000',
      updatedAt: 800,
    });
    const hybridActionExecutor = hybridExecutor();
    hybridActionExecutor.getMakerOrders.mockResolvedValue({
      orders: [stale],
      onchainOrders: [],
      offchainWithdrawalIsOnchainCancellation: false,
      warning: 'Withdrawal is off-chain only.',
    });
    const arcExecutor = executor();
    const { agent, logger } = createAgent({
      dataClient: dataClient({
        markets: [marketValue],
        books: new Map([['1', hybridBook(marketValue, [stale])]]),
      }),
      executor: arcExecutor,
      hybridExecutor: hybridActionExecutor,
      dryRun: false,
    });

    await agent.runCycle();

    expect(hybridActionExecutor.withdrawOrder).toHaveBeenCalledWith({
      order: stale,
    });
    expect(hybridActionExecutor.cancelOrder).toHaveBeenCalledWith({
      order: stale,
    });
    expect(arcExecutor.cancelOrder).not.toHaveBeenCalled();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'withdrawal',
        message: expect.stringMatching(/instantly and free.*still valid on-chain/u),
      }),
    );
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'broadcast',
        action: 'CANCEL',
        message: expect.stringMatching(/authoritative.*costs gas/u),
      }),
    );
  });

  it('refuses place/fill decisions for a non-tradable indexed market', async () => {
    const bootstrap = market('1', {
      phase: 'Opened',
      bookAddress: null,
      graduatedAt: null,
    });
    const unavailableBook: MarketBookResponse = {
      ...book(bootstrap, [order()]),
      orderBookAvailable: false,
      liveVenue: 'LMSR',
      yes: {
        ...book(bootstrap).yes,
        bids: [],
        asks: [],
        bestBidRaw: null,
        bestAskRaw: null,
        orders: [],
      },
    };
    const actionExecutor = executor();
    const readSignal = vi.fn(async ({ marketId }: { marketId: string }) => ({
      signal: signal(marketId),
      paymentSpendRaw: 0n,
    }));
    const { agent, logger } = createAgent({
      dataClient: dataClient({
        markets: [bootstrap],
        books: new Map([['1', unavailableBook]]),
      }),
      executor: actionExecutor,
      readSignal,
      dryRun: false,
    });

    await agent.runCycle();

    expect(actionExecutor.placeOrder).not.toHaveBeenCalled();
    expect(actionExecutor.fillOrder).not.toHaveBeenCalled();
    expect(readSignal).not.toHaveBeenCalled();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'refused',
        reason: expect.stringContaining('liveVenue=LMSR'),
      }),
    );
  });

  it('holds without reading a signal or placing/filling at the global deadline', async () => {
    const endedMarket = market('1', { tradingEndsAt: 2_000 });
    const endedBook: AvailableMarketBookResponse = {
      ...book(endedMarket, [order({ maker: MAKER, priceRaw: '100000' })]),
      tradingOpen: false,
    };
    const actionExecutor = executor();
    const readSignal = vi.fn(async ({ marketId }: { marketId: string }) => ({
      signal: signal(marketId),
      paymentSpendRaw: 0n,
    }));
    const { agent, logger } = createAgent({
      dataClient: dataClient({
        markets: [endedMarket],
        books: new Map([['1', endedBook]]),
      }),
      executor: actionExecutor,
      readSignal,
      dryRun: false,
      nowSeconds: () => 2_000,
    });

    await agent.runCycle();

    expect(readSignal).not.toHaveBeenCalled();
    expect(actionExecutor.placeOrder).not.toHaveBeenCalled();
    expect(actionExecutor.fillOrder).not.toHaveBeenCalled();
    expect(actionExecutor.cancelOrder).not.toHaveBeenCalled();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'refused',
        action: 'HOLD',
        reason: expect.stringContaining('global trading deadline reached'),
      }),
    );
  });

  it('cancels and replaces a stale own quote', async () => {
    const staleBid = order({
      orderId: '8',
      maker: TRADER,
      side: 'BID',
      priceRaw: '500000',
      updatedAt: 800,
    });
    const marketValue = market();
    const actionExecutor = executor();
    const { agent } = createAgent({
      dataClient: dataClient({
        markets: [marketValue],
        books: new Map([['1', book(marketValue, [staleBid])]]),
      }),
      executor: actionExecutor,
      dryRun: false,
    });

    await agent.runCycle();

    expect(actionExecutor.cancelOrder).toHaveBeenCalledWith({ orderId: '8' });
    expect(actionExecutor.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'BID', priceRaw: 580_000n }),
    );
  });

  it('logs a backend outage and a later loop cycle still acts', async () => {
    let listCalls = 0;
    const client = dataClient();
    client.listMarkets = vi.fn(async () => {
      listCalls += 1;
      if (listCalls === 1) throw new Error('backend offline');
      return { items: [market()], nextCursor: null };
    });
    const { agent, logger } = createAgent({ dataClient: client });

    await runTraderLoop(agent, {
      pollIntervalMs: 1,
      maxCycles: 2,
      sleep: async () => {},
      logger,
    });

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'backend-error',
        message: expect.stringContaining('backend offline'),
      }),
    );
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ event: 'dry-run', action: 'PLACE' }),
    );
  });

  it('logs a signal failure and continues to the next market', async () => {
    const first = market('1');
    const second = market('2');
    const { agent, logger } = createAgent({
      dataClient: dataClient({
        markets: [first, second],
        books: new Map([
          ['1', book(first)],
          ['2', book(second)],
        ]),
        accountResponse: account([]),
      }),
      readSignal: vi.fn(async ({ marketId }) => {
        if (marketId === '1') throw new Error('signal unavailable');
        return { signal: signal(marketId), paymentSpendRaw: 0n };
      }),
    });

    await agent.runCycle();

    expect(logger.entries).toContainEqual(
      expect.objectContaining({ event: 'signal-error', marketId: '1' }),
    );
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ event: 'dry-run', marketId: '2' }),
    );
  });

  it('logs an RPC action error and continues with the next action', async () => {
    const actionExecutor = executor();
    actionExecutor.placeOrder
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValueOnce({
        txHash: `0x${'4'.repeat(64)}`,
        orderId: '101',
      });
    const { agent, logger } = createAgent({
      executor: actionExecutor,
      dryRun: false,
    });

    await agent.runCycle();

    expect(actionExecutor.placeOrder).toHaveBeenCalledTimes(2);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'action-error',
        message: expect.stringContaining('RPC timeout'),
      }),
    );
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ event: 'broadcast', side: 'ASK' }),
    );
  });

  it('reserves every cap conservatively when a broadcast receipt is uncertain', async () => {
    const actionExecutor = executor();
    const hash = `0x${'5'.repeat(64)}` as const;
    actionExecutor.placeOrder.mockRejectedValueOnce(
      new BroadcastUncertainError(hash, true, 'receipt RPC timed out'),
    );
    const { agent, logger } = createAgent({
      executor: actionExecutor,
      dryRun: false,
      maxOrdersInFlight: 1,
    });

    await agent.runCycle();

    expect(actionExecutor.placeOrder).toHaveBeenCalledTimes(1);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'action-error',
        txHash: hash,
        message: expect.stringContaining('reserving order/inventory/spend caps'),
      }),
    );
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'refused',
        side: 'ASK',
        reason: expect.stringContaining('max-orders-in-flight cap'),
      }),
    );
  });
});
