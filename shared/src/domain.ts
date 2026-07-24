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

export interface OrderBook {
  marketId: string;
  outcome: Outcome;
  tokenId: string;
  bids: BookLevel[]; // sorted best (highest price) first
  asks: BookLevel[]; // sorted best (lowest price) first
  orders: Order[]; // raw open orders backing the ladder (thin book — small)
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
