import type {
  Market,
  MarketPhase,
  Outcome,
  Position,
  Resolution,
  ResolutionOutcome,
} from '@predex-pump/shared/domain';

const RAW_SCALE = 1_000_000n;

export function indexedResolution(
  market: Market,
  detailResolution?: Resolution | null,
): Resolution | null {
  return detailResolution ?? market.resolution ?? null;
}

/**
 * A payout makes a market economically final even when the incubator has not
 * yet observed it and its on-chain lifecycle still reports Opened/Graduated.
 */
export function isMarketSettled(
  market: Market,
  detailResolution?: Resolution | null,
): boolean {
  return (
    indexedResolution(market, detailResolution) !== null ||
    market.resolvedAt !== null ||
    market.phase === 'ResolvedObserved' ||
    market.phase === 'ClosedOut'
  );
}

export function displayMarketPhase(
  market: Market,
  detailResolution?: Resolution | null,
): MarketPhase {
  if (market.phase === 'ClosedOut') return 'ClosedOut';
  return isMarketSettled(market, detailResolution)
    ? 'ResolvedObserved'
    : market.phase;
}

export function resolvedOutcome(
  market: Market,
  detailResolution?: Resolution | null,
): ResolutionOutcome | null {
  const resolution = indexedResolution(market, detailResolution);
  if (resolution !== null) return resolution.outcome;
  if (!isMarketSettled(market)) return null;
  if (market.yesPriceRaw === '1000000' && market.noPriceRaw === '0') {
    return 'YES';
  }
  if (market.noPriceRaw === '1000000' && market.yesPriceRaw === '0') {
    return 'NO';
  }
  if (market.yesPriceRaw === '500000' && market.noPriceRaw === '500000') {
    return 'INVALID';
  }
  return null;
}

export function resolutionPriceRaw(
  market: Market,
  outcome: Outcome,
  detailResolution?: Resolution | null,
): string | null {
  const resolution = indexedResolution(market, detailResolution);
  if (resolution === null || resolution.denominator <= 0) return null;
  const numerator = outcome === 'YES' ? resolution.payoutYes : resolution.payoutNo;
  return (
    (BigInt(numerator) * RAW_SCALE) /
    BigInt(resolution.denominator)
  ).toString();
}

export function marketPriceRaw(
  market: Market,
  outcome: Outcome,
  detailResolution?: Resolution | null,
): string {
  return (
    resolutionPriceRaw(market, outcome, detailResolution) ??
    (outcome === 'YES' ? market.yesPriceRaw : market.noPriceRaw)
  );
}

export function positionCurrentValueRaw(
  position: Position,
  market: Market | undefined,
): string {
  if (market === undefined) return '0';
  const payoutPrice = resolutionPriceRaw(market, position.outcome);
  if (payoutPrice !== null) {
    return (
      (BigInt(position.qtyRaw) * BigInt(payoutPrice)) /
      RAW_SCALE
    ).toString();
  }
  if (isMarketSettled(market)) {
    // The indexer marks unrealized PnL at the final payout. This fallback keeps
    // older market snapshots with no embedded resolution from using a stale
    // graduation marginal price.
    const markedValue =
      BigInt(position.costBasisRaw) + BigInt(position.unrealizedPnlRaw);
    return (markedValue > 0n ? markedValue : 0n).toString();
  }
  const marginalPrice =
    position.outcome === 'YES' ? market.yesPriceRaw : market.noPriceRaw;
  return (
    (BigInt(position.qtyRaw) * BigInt(marginalPrice)) /
    RAW_SCALE
  ).toString();
}
