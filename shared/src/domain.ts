// Domain DTOs — the shape the backend serves and the frontend renders.
//
// ─── Units convention (READ THIS) ────────────────────────────────────────────────
// Every on-chain integer that can exceed 2^53 is a DECIMAL STRING of the raw integer
// (never a JS number). Fields carrying such values are suffixed `Raw`.
//   • USDC amounts        → 6-dec raw string. "1000000" = 1 USDC.
//   • CTF token sizes      → 6-dec raw string (same scale as the collateral). "1000000" = 1 token.
//   • Prices (LMSR & book) → 6-dec raw string. "1000000" = 1 USDC per whole token; YES+NO price = "1000000".
//   • tokenId / conditionId / questionId → decimal-or-hex string (uint256 / bytes32).
//   • Addresses → lowercase 0x string.
//   • Timestamps → unix SECONDS as a number (safe < 2^53).
// ─────────────────────────────────────────────────────────────────────────────────

export type Address = `0x${string}`;
export type Hash = `0x${string}`;
/** Decimal string of a raw on-chain uint (6-dec unless the field says otherwise). */
export type Raw = string;

/** Mirrors the on-chain IncubatorStructs.MarketState. */
export type MarketPhase = 'Opened' | 'Graduated' | 'ResolvedObserved' | 'ClosedOut';

/** Mirrors the on-chain MiniCLOB.Side (BID = 0, ASK = 1). */
export type OrderSide = 'BID' | 'ASK';

export type Outcome = 'YES' | 'NO';

/** Committee resolution: [1,0]=YES, [0,1]=NO, [1,1]=INVALID (half-payout each). */
export type ResolutionOutcome = 'YES' | 'NO' | 'INVALID';

/** Where a trade executed. */
export type Venue = 'LMSR' | 'BOOK';

/** The single order-book venue currently accepting trades for a market. */
export type LiveBookVenue = 'MINICLOB' | 'HYBRID';

/** Snapshot of the immutable-per-market economic params (indexed at creation). */
export interface MarketParams {
  seedFloorRaw: Raw;
  seedCapRaw: Raw;
  fCapRaw: Raw;
  graduationMoneyInThresholdRaw: Raw;
  graduationTollRaw: Raw;
  inventoryTargetRaw: Raw;
  protocolFeeBps: number;
  depthFeeBps: number;
  tradingWindowSeconds: number;
  minimumTimeOpenSeconds: number;
  /** Mutable off-chain order-price quantum for this market. */
  minimumTickSizeRaw: Raw;
}

export interface Market {
  id: string; // marketId
  creator: Address;
  question: string; // decoded from ancillaryData (utf-8), else the raw hex
  phase: MarketPhase;
  conditionId: string;
  questionId: string;
  yesTokenId: string;
  noTokenId: string;
  seedRaw: Raw;
  // Live LMSR marginal prices (sum to 1000000). Present while tradable; frozen at graduation.
  yesPriceRaw: Raw;
  noPriceRaw: Raw;
  // Cumulative non-creator buy base that drives graduation eligibility (monotonic).
  graduationActivityRaw: Raw;
  // Graduated-book linkage (present once phase >= Graduated and a book was seeded).
  bookAddress: Address | null;
  frozenYesPriceRaw: Raw | null; // YES ASK price the book opened at
  handoffSizeRaw: Raw | null; // K complete sets seeded into the book
  // Rollups.
  tradeCount: number;
  volumeRaw: Raw; // cumulative USDC notional across LMSR + book
  params: MarketParams;
  createdAt: number;
  tradingEndsAt: number;
  graduatedAt: number | null;
  resolvedAt: number | null;
  /**
   * Indexed payout data when the oracle/CTF condition is final. This can be
   * present before the incubator lifecycle advances to ResolvedObserved.
   * Optional for compatibility with older snapshots and locally-built previews.
   */
  resolution?: Resolution | null;
}

export interface Trade {
  id: string; // `${txHash}:${logIndex}`
  marketId: string;
  venue: Venue;
  account: Address;
  outcome: Outcome;
  // LMSR: BID = buy / ASK = sell of the outcome. BOOK: the taker's effective side.
  side: OrderSide;
  sizeRaw: Raw;
  priceRaw: Raw; // effective avg price for this trade
  costRaw: Raw; // USDC in (buy) / out (sell), fee-inclusive
  feeRaw: Raw;
  txHash: Hash;
  logIndex: number;
  ts: number;
}

export interface Order {
  orderId: string;
  marketId: string;
  conditionId: string;
  tokenId: string;
  outcome: Outcome; // derived from tokenId
  maker: Address;
  side: OrderSide;
  priceRaw: Raw;
  sizeRaw: Raw;
  filledRaw: Raw;
  remainingRaw: Raw;
  open: boolean;
  isSeed: boolean; // true = protocol quote posted by the graduation handoff
  createdAt: number;
  updatedAt: number;
}

export interface Fill {
  id: string; // `${txHash}:${logIndex}`
  orderId: string;
  marketId: string;
  taker: Address;
  maker: Address;
  outcome: Outcome;
  fillSizeRaw: Raw;
  paymentRaw: Raw; // USDC moved maker<->taker
  filledAfterRaw: Raw;
  openAfter: boolean;
  txHash: Hash;
  logIndex: number;
  ts: number;
}

/** One price level of the aggregated book ladder (thin book: usually 1 order per level). */
export interface BookLevel {
  priceRaw: Raw;
  sizeRaw: Raw; // sum of remaining across orders at this price
  orderCount: number;
}

/** JSON-safe representation of the exact CTFExchange struct that was signed. */
export interface SignedCtfExchangeOrder {
  saltRaw: Raw;
  maker: Address;
  signer: Address;
  taker: Address;
  tokenId: Raw;
  makerAmountRaw: Raw;
  takerAmountRaw: Raw;
  expiration: number;
  nonceRaw: Raw;
  feeRateBpsRaw: Raw;
  side: 0 | 1; // CTFExchange Side.BUY | Side.SELL
  signatureType: 0 | 1 | 2 | 3;
  signature: `0x${string}`;
}

export type OffchainOrderStatus =
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'WITHDRAWN'
  | 'CANCELLED'
  | 'NONCE_INVALIDATED'
  | 'EXPIRED'
  | 'MARKET_RESOLVED';

export type OrderUnfillableReason =
  | 'NOT_OPEN'
  | 'WITHDRAWN'
  | 'EXPIRED'
  | 'MARKET_RESOLVED'
  | 'INSUFFICIENT_BALANCE'
  | 'MISSING_APPROVAL'
  | 'INDEXED_STATE_UNAVAILABLE';

/** A signed order held by the operator, distinct from an escrowed MiniCLOB Order. */
export interface OffchainOrder {
  orderHash: Hash;
  marketId: string;
  conditionId: Hash;
  tokenId: Raw;
  outcome: Outcome;
  maker: Address;
  side: OrderSide;
  priceRaw: Raw;
  sizeRaw: Raw;
  filledRaw: Raw;
  remainingRaw: Raw;
  status: OffchainOrderStatus;
  fillable: boolean;
  unfillableReason: OrderUnfillableReason | null;
  signedOrder: SignedCtfExchangeOrder;
  createdAt: number;
  updatedAt: number;
}

export interface OrderBook {
  marketId: string;
  /** Effective per-market price quantum applied to newly accepted orders. */
  minimumTickSizeRaw: Raw;
  outcome: Outcome;
  tokenId: string;
  bids: BookLevel[]; // sorted best (highest price) first
  asks: BookLevel[]; // sorted best (lowest price) first
  bestBidRaw: Raw | null;
  bestAskRaw: Raw | null;
  orders: Order[]; // raw open orders backing the ladder (thin book — small)
  /** Fillable signed CTFExchange orders included in the same aggregated levels. */
  offchainOrders: OffchainOrder[];
}

export interface Position {
  account: Address;
  marketId: string;
  outcome: Outcome;
  qtyRaw: Raw; // net CTF held (from ERC-1155 transfers)
  costBasisRaw: Raw; // ESTIMATED — derived from indexed trade prices, not authoritative
  costBasisEstimated: true;
  realizedPnlRaw: Raw;
  unrealizedPnlRaw: Raw; // marked to current price (live) or resolution payout (resolved)
  updatedAt: number;
}

export interface Resolution {
  marketId: string;
  conditionId: string;
  outcome: ResolutionOutcome;
  payoutYes: number; // 1 | 0
  payoutNo: number; // 0 | 1
  denominator: number; // 1 valid, 2 invalid
  resolvedAt: number; // committee resolve
  observedAt: number | null; // incubator observeResolution
}

export interface Account {
  address: Address;
  firstSeenAt: number;
  marketsCreated: number;
  tradeCount: number;
}

/**
 * Deliberately small, off-chain profile state. This record excludes positions,
 * trades, PnL, wallet metadata, IP addresses, and device identifiers.
 */
export interface AccountProfile {
  address: Address;
  displayName: string | null;
  preferences: {
    /** Controls both retention and display of the recently-viewed list. */
    rememberRecentlyViewed: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

/** The only modest behavior signals persisted by the account layer. */
export type AccountBehaviorType =
  | 'MARKET_VIEWED'
  | 'DEDUP_SUGGESTION_ACCEPTED'
  | 'DEDUP_SUGGESTION_REJECTED';

export interface AccountBehaviorRecord {
  type: AccountBehaviorType;
  /** Viewed market, or the existing market suggested by the dedup feature. */
  marketId: string;
  occurredAt: string;
}

/** All monetary fields remain derived from the indexed on-chain read model. */
export interface AccountTrackRecord {
  marketsCreated: number;
  marketsTraded: number;
  tradeCount: number;
  volumeTradedRaw: Raw;
  realizedPnlRaw: Raw;
  unrealizedPnlRaw: Raw;
  dedupSuggestionsAccepted: number;
  dedupSuggestionsRejected: number;
}

export type ActivityType =
  | 'MarketCreated'
  | 'Trade'
  | 'MarketGraduated'
  | 'BookSeeded'
  | 'OrderPlaced'
  | 'OrderFilled'
  | 'OrderCancelled'
  | 'ResolutionObserved'
  | 'Closeout'
  | 'Redeem';

export interface ActivityEvent {
  id: string; // `${txHash}:${logIndex}`
  type: ActivityType;
  marketId: string | null;
  account: Address | null;
  // Small type-specific summary for the timeline (all optional).
  outcome?: Outcome;
  side?: OrderSide;
  amountRaw?: Raw;
  priceRaw?: Raw;
  txHash: Hash;
  ts: number;
}

export interface Pnl {
  realizedRaw: Raw;
  unrealizedRaw: Raw;
}

/** One point of the price curve, derived from the LMSR `TradeState` stream. */
export interface PricePoint {
  ts: number;
  yesPriceRaw: Raw;
  noPriceRaw: Raw;
}

/**
 * An explainable estimate computed only from the indexed Predex read model.
 * This is market microstructure, not an external fact oracle or resolution claim.
 */
export interface TruthSignal {
  marketId: string;
  estimateType: 'INDEXED_MARKET_ESTIMATE';
  fairValueYesRaw: Raw;
  fairValueNoRaw: Raw;
  inputs: {
    currentImpliedYesRaw: Raw;
    recentPrice: {
      pointsUsed: number;
      oldestTs: number | null;
      latestTs: number | null;
      oldestYesPriceRaw: Raw | null;
      latestYesPriceRaw: Raw | null;
      /** Signed six-decimal price change; unlike Raw, this may be negative. */
      changeRaw: string;
    };
    yesBook: {
      bestBidRaw: Raw | null;
      bestAskRaw: Raw | null;
      midpointRaw: Raw | null;
      bidLiquidityRaw: Raw;
      askLiquidityRaw: Raw;
      /** Signed parts-per-million depth imbalance, or null for an empty book. */
      imbalancePpm: number | null;
    };
    context: {
      phase: MarketPhase;
      tradeCount: number;
      volumeRaw: Raw;
    };
  };
  derivation: {
    method: 'INDEXED_MARKET_MICROSTRUCTURE_V1';
    formula: string;
    currentImpliedWeightBps: 7_000;
    bookMidpointWeightBps: 3_000;
    trendWeightBps: 1_000;
    maxAbsTrendAdjustmentRaw: '25000';
    maxAbsImbalanceAdjustmentRaw: '15000';
    baseRaw: Raw;
    /** Signed six-decimal price adjustment. */
    trendAdjustmentRaw: string;
    /** Signed six-decimal price adjustment. */
    imbalanceAdjustmentRaw: string;
    /** Signed before the final [0, 1] probability clamp. */
    unclampedFairValueYesRaw: string;
  };
  caveats: string[];
}

/** Committee (oracle) resolver set — display + gating only; the resolve tx re-checks on-chain. */
export interface CommitteeInfo {
  oracle: Address;
  signers: Address[];
  threshold: number;
}

/** Registry-level config a fresh CreateMarket / SettlementPanel needs before any market exists. */
export interface RegistryConfig {
  chainId: number;
  addresses: {
    usdc: Address;
    ctf: Address;
    oracle: Address;
    lmsr: Address;
    registry: Address;
    miniClob: Address;
  };
  marketTypeVersion: number;
  seedFloorRaw: Raw;
  seedCapRaw: Raw;
  graduationTollRaw: Raw;
  protocolFeeBps: number;
  /** Optional only so older serialized config payloads remain assignable. Live Arc reads always set it. */
  minTradingWindowSeconds?: number;
  /** Optional only so older serialized config payloads remain assignable. Live Arc reads always set it. */
  maxTradingWindowSeconds?: number;
  committee: CommitteeInfo;
}

/** Normalized identity of the real-world fact asked by a market question. */
export interface MarketFactFields {
  subject: string | null;
  comparator: string | null;
  strike: string | null;
  deadline: string | null;
  basis: string | null;
}

/** An existing market considered by the creation-time duplicate check. */
export interface DedupCandidate {
  marketId: string;
  /** Cosine similarity returned by the ANN index. */
  score: number;
  /** Conservative same-fact judgment or the authoritative field conflict. */
  reason: string;
}
