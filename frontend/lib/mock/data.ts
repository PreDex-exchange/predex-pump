import type {
  ActivityEvent,
  Address,
  Hash,
  Market,
  MarketParams,
  Order,
  OrderBook,
  Position,
  PricePoint,
  Resolution,
  Trade,
} from '@predex-pump/shared/domain';
import type {
  AccountResponse,
  ConfigResponse,
  MarketBookResponse,
} from '@predex-pump/shared/rest';

import { ADDRESSES, ARC } from '@/lib/shared/addresses';

export const MOCK_REFERENCE_TS = 1_784_831_400;
export const MOCK_WALLET_ADDRESS =
  '0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3f3d' as Address;
export const MOCK_FEED_STATS = {
  markets: 42,
  graduated: 7,
  volumeRaw: '184300000000',
} as const;

const CREATORS = {
  one: '0x4c0891b20e2f34f5a44ce91b8a7c6c81e9c319ea' as Address,
  two: '0x91d4032b880915dc112ac42a7074fc9c678d84c2' as Address,
  three: '0x7be029be4f50bcd1ca1cfb8f2ed34a910c2a112a' as Address,
};

const ACCOUNTS = {
  traderOne: '0x7b9af41a6c5e2c93288818cb923809efd902112a' as Address,
  traderTwo: '0x3df1c3ff41b8218d4af62ec92ac71992ac0df8fe' as Address,
  traderThree: '0x917cc1022fc07f968b84cc908c3a2e67c191e4c2' as Address,
};

function hash(character: string): Hash {
  return `0x${character.repeat(64)}` as Hash;
}

function bytes32(character: string) {
  return `0x${character.repeat(64)}`;
}

const DEFAULT_PARAMS: MarketParams = {
  seedFloorRaw: '100000000',
  seedCapRaw: '5000000000',
  fCapRaw: '25000000000',
  graduationMoneyInThresholdRaw: '12500000000',
  graduationTollRaw: '100000',
  inventoryTargetRaw: '1000000000',
  protocolFeeBps: 20,
  depthFeeBps: 100,
  tradingWindowSeconds: 604_800,
  minimumTimeOpenSeconds: 600,
};

function makeMarket(
  id: string,
  input: Pick<
    Market,
    | 'creator'
    | 'question'
    | 'phase'
    | 'yesPriceRaw'
    | 'noPriceRaw'
    | 'graduationActivityRaw'
    | 'tradeCount'
    | 'volumeRaw'
    | 'createdAt'
  > &
    Partial<
      Pick<
        Market,
        | 'seedRaw'
        | 'bookAddress'
        | 'frozenYesPriceRaw'
        | 'handoffSizeRaw'
        | 'tradingEndsAt'
        | 'graduatedAt'
        | 'resolvedAt'
      >
    >,
): Market {
  const tokenBase = BigInt(id) * 10_000n;

  return {
    id,
    creator: input.creator,
    question: input.question,
    phase: input.phase,
    conditionId: bytes32(id),
    questionId: bytes32(String((Number(id) + 7) % 10)),
    yesTokenId: (tokenBase + 1n).toString(),
    noTokenId: (tokenBase + 2n).toString(),
    seedRaw: input.seedRaw ?? '500000000',
    yesPriceRaw: input.yesPriceRaw,
    noPriceRaw: input.noPriceRaw,
    graduationActivityRaw: input.graduationActivityRaw,
    bookAddress: input.bookAddress ?? null,
    frozenYesPriceRaw: input.frozenYesPriceRaw ?? null,
    handoffSizeRaw: input.handoffSizeRaw ?? null,
    tradeCount: input.tradeCount,
    volumeRaw: input.volumeRaw,
    params: { ...DEFAULT_PARAMS },
    createdAt: input.createdAt,
    tradingEndsAt: input.tradingEndsAt ?? input.createdAt + DEFAULT_PARAMS.tradingWindowSeconds,
    graduatedAt: input.graduatedAt ?? null,
    resolvedAt: input.resolvedAt ?? null,
  };
}

export const MOCK_MARKETS: Market[] = [
  makeMarket('1', {
    creator: CREATORS.one,
    question: 'Will ETH close above $4,000 this Friday?',
    phase: 'Opened',
    yesPriceRaw: '520000',
    noPriceRaw: '480000',
    graduationActivityRaw: '8470000000',
    tradeCount: 84,
    volumeRaw: '12480000000',
    createdAt: MOCK_REFERENCE_TS - 120,
  }),
  makeMarket('2', {
    creator: CREATORS.two,
    question: 'Will the Fed cut rates in September?',
    phase: 'Opened',
    yesPriceRaw: '410000',
    noPriceRaw: '590000',
    graduationActivityRaw: '4250000000',
    tradeCount: 51,
    volumeRaw: '8210000000',
    createdAt: MOCK_REFERENCE_TS - 1_440,
  }),
  makeMarket('3', {
    creator: CREATORS.three,
    question: 'Will Starship reach orbit this quarter?',
    phase: 'Graduated',
    yesPriceRaw: '730000',
    noPriceRaw: '270000',
    graduationActivityRaw: '14380000000',
    tradeCount: 219,
    volumeRaw: '54900000000',
    createdAt: MOCK_REFERENCE_TS - 52_000,
    graduatedAt: MOCK_REFERENCE_TS - 660,
    bookAddress: ADDRESSES.miniClob,
    frozenYesPriceRaw: '710000',
    handoffSizeRaw: '1800000000',
  }),
  makeMarket('4', {
    creator: CREATORS.one,
    question: 'Will BTC set a new all-time high before August?',
    phase: 'Opened',
    yesPriceRaw: '290000',
    noPriceRaw: '710000',
    graduationActivityRaw: '1500000000',
    tradeCount: 22,
    volumeRaw: '3050000000',
    createdAt: MOCK_REFERENCE_TS - 2_400,
  }),
  makeMarket('5', {
    creator: CREATORS.two,
    question: 'Will “Dune: Part Three” be announced at Comic-Con?',
    phase: 'Graduated',
    yesPriceRaw: '610000',
    noPriceRaw: '390000',
    graduationActivityRaw: '12950000000',
    tradeCount: 132,
    volumeRaw: '21700000000',
    createdAt: MOCK_REFERENCE_TS - 98_000,
    graduatedAt: MOCK_REFERENCE_TS - 3_600,
    bookAddress: ADDRESSES.miniClob,
    frozenYesPriceRaw: '600000',
    handoffSizeRaw: '1200000000',
  }),
  makeMarket('6', {
    creator: CREATORS.three,
    question: 'Will 2026 set a global temperature record?',
    phase: 'ResolvedObserved',
    yesPriceRaw: '1000000',
    noPriceRaw: '0',
    graduationActivityRaw: '15600000000',
    tradeCount: 178,
    volumeRaw: '9340000000',
    createdAt: MOCK_REFERENCE_TS - 430_000,
    graduatedAt: MOCK_REFERENCE_TS - 220_000,
    resolvedAt: MOCK_REFERENCE_TS - 3_900,
    bookAddress: ADDRESSES.miniClob,
    frozenYesPriceRaw: '680000',
    handoffSizeRaw: '1500000000',
  }),
  makeMarket('7', {
    creator: CREATORS.one,
    question: 'Will the Arc testnet process 1 million transactions this week?',
    phase: 'ClosedOut',
    yesPriceRaw: '0',
    noPriceRaw: '1000000',
    graduationActivityRaw: '13100000000',
    tradeCount: 96,
    volumeRaw: '16740000000',
    createdAt: MOCK_REFERENCE_TS - 620_000,
    graduatedAt: MOCK_REFERENCE_TS - 410_000,
    resolvedAt: MOCK_REFERENCE_TS - 90_000,
    bookAddress: ADDRESSES.miniClob,
    frozenYesPriceRaw: '440000',
    handoffSizeRaw: '900000000',
  }),
];

export const MOCK_RESOLUTIONS: Record<string, Resolution> = {
  '6': {
    marketId: '6',
    conditionId: MOCK_MARKETS[5].conditionId,
    outcome: 'YES',
    payoutYes: 1,
    payoutNo: 0,
    denominator: 1,
    resolvedAt: MOCK_REFERENCE_TS - 3_900,
    observedAt: MOCK_REFERENCE_TS - 3_840,
  },
  '7': {
    marketId: '7',
    conditionId: MOCK_MARKETS[6].conditionId,
    outcome: 'NO',
    payoutYes: 0,
    payoutNo: 1,
    denominator: 1,
    resolvedAt: MOCK_REFERENCE_TS - 90_000,
    observedAt: MOCK_REFERENCE_TS - 89_940,
  },
};

export const MOCK_TRADES: Trade[] = [
  {
    id: `${hash('a')}:4`,
    marketId: '1',
    venue: 'LMSR',
    account: ACCOUNTS.traderOne,
    outcome: 'YES',
    side: 'BID',
    sizeRaw: '48140000',
    priceRaw: '520000',
    costRaw: '25000000',
    feeRaw: '50000',
    txHash: hash('a'),
    logIndex: 4,
    ts: MOCK_REFERENCE_TS - 60,
  },
  {
    id: `${hash('b')}:8`,
    marketId: '1',
    venue: 'LMSR',
    account: ACCOUNTS.traderTwo,
    outcome: 'NO',
    side: 'ASK',
    sizeRaw: '120000000',
    priceRaw: '470000',
    costRaw: '56300000',
    feeRaw: '112600',
    txHash: hash('b'),
    logIndex: 8,
    ts: MOCK_REFERENCE_TS - 360,
  },
  {
    id: `${hash('c')}:2`,
    marketId: '1',
    venue: 'LMSR',
    account: ACCOUNTS.traderThree,
    outcome: 'YES',
    side: 'BID',
    sizeRaw: '210000000',
    priceRaw: '500000',
    costRaw: '105210000',
    feeRaw: '210000',
    txHash: hash('c'),
    logIndex: 2,
    ts: MOCK_REFERENCE_TS - 840,
  },
  {
    id: `${hash('d')}:5`,
    marketId: '3',
    venue: 'BOOK',
    account: MOCK_WALLET_ADDRESS,
    outcome: 'YES',
    side: 'BID',
    sizeRaw: '45000000',
    priceRaw: '730000',
    costRaw: '32850000',
    feeRaw: '65700',
    txHash: hash('d'),
    logIndex: 5,
    ts: MOCK_REFERENCE_TS - 720,
  },
  {
    id: `${hash('e')}:3`,
    marketId: '5',
    venue: 'BOOK',
    account: ACCOUNTS.traderTwo,
    outcome: 'NO',
    side: 'BID',
    sizeRaw: '80000000',
    priceRaw: '390000',
    costRaw: '31200000',
    feeRaw: '62400',
    txHash: hash('e'),
    logIndex: 3,
    ts: MOCK_REFERENCE_TS - 2_880,
  },
];

function buildPricePoints(yesPrices: number[]): PricePoint[] {
  return yesPrices.map((yesPrice, index) => ({
    ts: MOCK_REFERENCE_TS - (yesPrices.length - 1 - index) * 3_600,
    yesPriceRaw: String(yesPrice),
    noPriceRaw: String(1_000_000 - yesPrice),
  }));
}

export const MOCK_PRICE_HISTORY: Record<string, PricePoint[]> = {
  '1': buildPricePoints([
    440000, 450000, 438000, 462000, 480000, 472000, 493000, 501000, 489000, 511000,
    520000,
  ]),
  '2': buildPricePoints([
    520000, 500000, 508000, 476000, 460000, 445000, 452000, 430000, 410000,
  ]),
  '3': buildPricePoints([
    390000, 420000, 450000, 490000, 540000, 570000, 620000, 660000, 700000, 730000,
  ]),
  '4': buildPricePoints([440000, 420000, 390000, 360000, 335000, 310000, 290000]),
  '5': buildPricePoints([530000, 550000, 540000, 570000, 590000, 580000, 610000]),
  '6': buildPricePoints([520000, 580000, 620000, 700000, 790000, 900000, 1000000]),
  '7': buildPricePoints([510000, 470000, 420000, 350000, 220000, 80000, 0]),
};

function makeOrder(
  orderId: string,
  market: Market,
  outcome: 'YES' | 'NO',
  side: 'BID' | 'ASK',
  priceRaw: string,
  sizeRaw: string,
  maker: Address,
  isSeed = false,
): Order {
  return {
    orderId,
    marketId: market.id,
    conditionId: market.conditionId,
    tokenId: outcome === 'YES' ? market.yesTokenId : market.noTokenId,
    outcome,
    maker,
    side,
    priceRaw,
    sizeRaw,
    filledRaw: '0',
    remainingRaw: sizeRaw,
    open: true,
    isSeed,
    createdAt: market.graduatedAt ?? market.createdAt,
    updatedAt: MOCK_REFERENCE_TS - 300,
  };
}

function bookFromOrders(market: Market, outcome: 'YES' | 'NO', orders: Order[]): OrderBook {
  const levelsFor = (side: 'BID' | 'ASK') => {
    const byPrice = new Map<string, { sizeRaw: bigint; orderCount: number }>();

    orders
      .filter((order) => order.side === side)
      .forEach((order) => {
        const existing = byPrice.get(order.priceRaw) ?? { sizeRaw: 0n, orderCount: 0 };
        byPrice.set(order.priceRaw, {
          sizeRaw: existing.sizeRaw + BigInt(order.remainingRaw),
          orderCount: existing.orderCount + 1,
        });
      });

    return [...byPrice.entries()]
      .map(([priceRaw, level]) => ({
        priceRaw,
        sizeRaw: level.sizeRaw.toString(),
        orderCount: level.orderCount,
      }))
      .sort((left, right) =>
        side === 'BID'
          ? BigInt(right.priceRaw) > BigInt(left.priceRaw)
            ? 1
            : BigInt(right.priceRaw) < BigInt(left.priceRaw)
              ? -1
              : 0
          : BigInt(left.priceRaw) > BigInt(right.priceRaw)
            ? 1
            : BigInt(left.priceRaw) < BigInt(right.priceRaw)
              ? -1
              : 0,
      );
  };

  return {
    marketId: market.id,
    outcome,
    tokenId: outcome === 'YES' ? market.yesTokenId : market.noTokenId,
    bids: levelsFor('BID'),
    asks: levelsFor('ASK'),
    orders,
  };
}

function emptyBook(market: Market, outcome: 'YES' | 'NO'): OrderBook {
  return {
    marketId: market.id,
    outcome,
    tokenId: outcome === 'YES' ? market.yesTokenId : market.noTokenId,
    bids: [],
    asks: [],
    orders: [],
  };
}

const starship = MOCK_MARKETS[2];
const starshipYesOrders = [
  makeOrder('301', starship, 'YES', 'BID', '710000', '240000000', ACCOUNTS.traderOne, true),
  makeOrder('302', starship, 'YES', 'BID', '700000', '135000000', ACCOUNTS.traderThree),
  makeOrder('303', starship, 'YES', 'ASK', '740000', '180000000', ACCOUNTS.traderTwo, true),
  makeOrder('304', starship, 'YES', 'ASK', '760000', '95000000', CREATORS.two),
];
const starshipNoOrders = [
  makeOrder('305', starship, 'NO', 'BID', '250000', '175000000', ACCOUNTS.traderTwo),
  makeOrder('306', starship, 'NO', 'ASK', '280000', '225000000', ACCOUNTS.traderOne, true),
];

export const MOCK_ORDER_BOOKS: Record<string, MarketBookResponse> = {
  '3': {
    marketId: '3',
    yes: bookFromOrders(starship, 'YES', starshipYesOrders),
    no: bookFromOrders(starship, 'NO', starshipNoOrders),
  },
};

for (const market of MOCK_MARKETS) {
  if (!MOCK_ORDER_BOOKS[market.id]) {
    MOCK_ORDER_BOOKS[market.id] = {
      marketId: market.id,
      yes: emptyBook(market, 'YES'),
      no: emptyBook(market, 'NO'),
    };
  }
}

const positions: Position[] = [
  {
    account: MOCK_WALLET_ADDRESS,
    marketId: '1',
    outcome: 'YES',
    qtyRaw: '48000000',
    costBasisRaw: '24000000',
    costBasisEstimated: true,
    realizedPnlRaw: '0',
    unrealizedPnlRaw: '960000',
    updatedAt: MOCK_REFERENCE_TS - 60,
  },
  {
    account: MOCK_WALLET_ADDRESS,
    marketId: '3',
    outcome: 'YES',
    qtyRaw: '45000000',
    costBasisRaw: '32850000',
    costBasisEstimated: true,
    realizedPnlRaw: '3200000',
    unrealizedPnlRaw: '0',
    updatedAt: MOCK_REFERENCE_TS - 720,
  },
  {
    account: MOCK_WALLET_ADDRESS,
    marketId: '6',
    outcome: 'YES',
    qtyRaw: '120000000',
    costBasisRaw: '81600000',
    costBasisEstimated: true,
    realizedPnlRaw: '0',
    unrealizedPnlRaw: '38400000',
    updatedAt: MOCK_REFERENCE_TS - 3_840,
  },
];

export const MOCK_ACCOUNT_RESPONSE: AccountResponse = {
  account: {
    address: MOCK_WALLET_ADDRESS,
    firstSeenAt: MOCK_REFERENCE_TS - 800_000,
    marketsCreated: 2,
    tradeCount: 37,
  },
  positions,
  recentTrades: MOCK_TRADES.filter((trade) => trade.account === MOCK_WALLET_ADDRESS),
  pnl: {
    realizedRaw: '3200000',
    unrealizedRaw: '39360000',
  },
};

export const MOCK_ACTIVITY: ActivityEvent[] = [
  {
    id: `${hash('1')}:1`,
    type: 'MarketCreated',
    marketId: '1',
    account: CREATORS.one,
    txHash: hash('1'),
    ts: MOCK_REFERENCE_TS - 120,
  },
  {
    id: `${hash('2')}:4`,
    type: 'MarketGraduated',
    marketId: '3',
    account: CREATORS.three,
    amountRaw: '1800000000',
    txHash: hash('2'),
    ts: MOCK_REFERENCE_TS - 660,
  },
  {
    id: `${hash('3')}:9`,
    type: 'OrderFilled',
    marketId: '3',
    account: ACCOUNTS.traderOne,
    outcome: 'YES',
    side: 'BID',
    amountRaw: '45000000',
    priceRaw: '730000',
    txHash: hash('3'),
    ts: MOCK_REFERENCE_TS - 720,
  },
  {
    id: `${hash('4')}:2`,
    type: 'MarketCreated',
    marketId: '2',
    account: CREATORS.two,
    txHash: hash('4'),
    ts: MOCK_REFERENCE_TS - 1_440,
  },
  {
    id: `${hash('5')}:7`,
    type: 'Trade',
    marketId: '1',
    account: ACCOUNTS.traderTwo,
    outcome: 'NO',
    side: 'ASK',
    amountRaw: '120000000',
    priceRaw: '470000',
    txHash: hash('5'),
    ts: MOCK_REFERENCE_TS - 2_200,
  },
  {
    id: `${hash('6')}:3`,
    type: 'ResolutionObserved',
    marketId: '6',
    account: null,
    outcome: 'YES',
    txHash: hash('6'),
    ts: MOCK_REFERENCE_TS - 3_840,
  },
  {
    id: `${hash('7')}:6`,
    type: 'BookSeeded',
    marketId: '5',
    account: null,
    amountRaw: '1200000000',
    txHash: hash('7'),
    ts: MOCK_REFERENCE_TS - 3_600,
  },
];

export const MOCK_CONFIG: ConfigResponse = {
  chainId: ARC.chainId,
  addresses: {
    usdc: ADDRESSES.usdc,
    ctf: ADDRESSES.ctf,
    oracle: ADDRESSES.oracle,
    lmsr: ADDRESSES.lmsr,
    registry: ADDRESSES.registry,
    miniClob: ADDRESSES.miniClob,
  },
  marketTypeVersion: 1,
  seedFloorRaw: DEFAULT_PARAMS.seedFloorRaw,
  seedCapRaw: DEFAULT_PARAMS.seedCapRaw,
  graduationTollRaw: DEFAULT_PARAMS.graduationTollRaw,
  protocolFeeBps: DEFAULT_PARAMS.protocolFeeBps,
  committee: {
    oracle: ADDRESSES.oracle,
    signers: [CREATORS.one, CREATORS.two, CREATORS.three],
    threshold: 2,
  },
};
