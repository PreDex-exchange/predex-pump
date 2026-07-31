import type {
  Market,
  MarketBookResponse,
  PricePoint,
  TruthSignalResponse,
} from '@predex-pump/shared';

const PRICE_SCALE = 1_000_000n;
const BPS_SCALE = 10_000n;
const CURRENT_WEIGHT_BPS = 7_000n;
const BOOK_WEIGHT_BPS = 3_000n;
const TREND_WEIGHT_BPS = 1_000n;
const MAX_TREND_ADJUSTMENT_RAW = 25_000n;
const MAX_IMBALANCE_ADJUSTMENT_RAW = 15_000n;

export interface TruthSignalSource {
  market: Pick<
    Market,
    'id' | 'phase' | 'yesPriceRaw' | 'tradeCount' | 'volumeRaw'
  >;
  book: MarketBookResponse;
  recentPrices: readonly PricePoint[];
}

function clamp(value: bigint, minimum: bigint, maximum: bigint): bigint {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function sumLiquidity(levels: readonly { sizeRaw: string }[]): bigint {
  return levels.reduce((total, level) => total + BigInt(level.sizeRaw), 0n);
}

/** Pure derivation kept separate from Prisma so fixtures can prove the arithmetic. */
export function deriveTruthSignal({
  market,
  book,
  recentPrices,
}: TruthSignalSource): TruthSignalResponse {
  const currentImplied = BigInt(market.yesPriceRaw);
  const bestBid = book.yes.bids[0]?.priceRaw ?? null;
  const bestAsk = book.yes.asks[0]?.priceRaw ?? null;
  const midpoint =
    bestBid === null || bestAsk === null
      ? null
      : (BigInt(bestBid) + BigInt(bestAsk)) / 2n;
  const bidLiquidity = sumLiquidity(book.yes.bids);
  const askLiquidity = sumLiquidity(book.yes.asks);
  const totalLiquidity = bidLiquidity + askLiquidity;
  const imbalancePpm =
    totalLiquidity === 0n
      ? null
      : Number(
          ((bidLiquidity - askLiquidity) * PRICE_SCALE) / totalLiquidity,
        );

  const oldest = recentPrices[0] ?? null;
  const latest = recentPrices.at(-1) ?? null;
  const priceChange =
    recentPrices.length < 2 || oldest === null || latest === null
      ? 0n
      : BigInt(latest.yesPriceRaw) - BigInt(oldest.yesPriceRaw);
  const base =
    midpoint === null
      ? currentImplied
      : (currentImplied * CURRENT_WEIGHT_BPS + midpoint * BOOK_WEIGHT_BPS) /
        BPS_SCALE;
  const trendAdjustment = clamp(
    (priceChange * TREND_WEIGHT_BPS) / BPS_SCALE,
    -MAX_TREND_ADJUSTMENT_RAW,
    MAX_TREND_ADJUSTMENT_RAW,
  );
  const imbalanceAdjustment =
    imbalancePpm === null
      ? 0n
      : (BigInt(imbalancePpm) * MAX_IMBALANCE_ADJUSTMENT_RAW) /
        PRICE_SCALE;
  const unclamped = base + trendAdjustment + imbalanceAdjustment;
  const fairValueYes = clamp(unclamped, 0n, PRICE_SCALE);
  const caveats = [
    'Derived only from the indexed Predex market; it is not an external fact oracle or a resolution prediction.',
    'Indexed inputs may lag Arc and must not be used as transaction-critical chain state.',
  ];
  if (midpoint === null) {
    caveats.push(
      'A two-sided YES book was unavailable, so the base uses only the indexed implied price.',
    );
  }
  if (recentPrices.length < 2) {
    caveats.push(
      'Fewer than two recent price points were available, so the trend adjustment is zero.',
    );
  }
  if (totalLiquidity === 0n) {
    caveats.push(
      'The YES book had no liquidity, so the imbalance adjustment is zero.',
    );
  }
  if (market.phase !== 'Graduated') {
    caveats.push(
      `Market phase is ${market.phase}; this signal does not assert that the market is tradable.`,
    );
  }

  return {
    marketId: market.id,
    estimateType: 'INDEXED_MARKET_ESTIMATE',
    fairValueYesRaw: fairValueYes.toString(),
    fairValueNoRaw: (PRICE_SCALE - fairValueYes).toString(),
    inputs: {
      currentImpliedYesRaw: currentImplied.toString(),
      recentPrice: {
        pointsUsed: recentPrices.length,
        oldestTs: oldest?.ts ?? null,
        latestTs: latest?.ts ?? null,
        oldestYesPriceRaw: oldest?.yesPriceRaw ?? null,
        latestYesPriceRaw: latest?.yesPriceRaw ?? null,
        changeRaw: priceChange.toString(),
      },
      yesBook: {
        bestBidRaw: bestBid,
        bestAskRaw: bestAsk,
        midpointRaw: midpoint?.toString() ?? null,
        bidLiquidityRaw: bidLiquidity.toString(),
        askLiquidityRaw: askLiquidity.toString(),
        imbalancePpm,
      },
      context: {
        phase: market.phase,
        tradeCount: market.tradeCount,
        volumeRaw: market.volumeRaw,
      },
    },
    derivation: {
      method: 'INDEXED_MARKET_MICROSTRUCTURE_V1',
      formula:
        'base = 70% current implied YES + 30% two-sided YES midpoint (or 100% current); fair = clamp(base + 10% recent change capped at ±0.025 + depth imbalance × 0.015, 0, 1)',
      currentImpliedWeightBps: 7_000,
      bookMidpointWeightBps: 3_000,
      trendWeightBps: 1_000,
      maxAbsTrendAdjustmentRaw: '25000',
      maxAbsImbalanceAdjustmentRaw: '15000',
      baseRaw: base.toString(),
      trendAdjustmentRaw: trendAdjustment.toString(),
      imbalanceAdjustmentRaw: imbalanceAdjustment.toString(),
      unclampedFairValueYesRaw: unclamped.toString(),
    },
    caveats,
  };
}
