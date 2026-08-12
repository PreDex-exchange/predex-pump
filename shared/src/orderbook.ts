/** Six-decimal probability/collateral scale shared by both book venues. */
export const ORDER_PRICE_SCALE_RAW = 1_000_000n;

/**
 * Predex supports the Polymarket-style decimal ticks at or coarser than 0.001
 * that remain useful for a binary book and are exactly representable by the
 * exchange at the system size quantum. A 100-raw (0.0001) tick is deliberately
 * absent: it does not round-trip at the sizes used by Predex. A 1,000,000-raw
 * tick is also absent because it offers no interior binary-market price.
 */
export const ALLOWED_MINIMUM_TICK_SIZES_RAW = [
  1_000n,
  10_000n,
  100_000n,
] as const;

export type AllowedMinimumTickSizeRaw =
  (typeof ALLOWED_MINIMUM_TICK_SIZES_RAW)[number];

/** Default to the finest supported tick: 0.001000 USDC per token. */
export const DEFAULT_MINIMUM_TICK_SIZE_RAW: AllowedMinimumTickSizeRaw = 1_000n;

/**
 * 0.001 token. Since every allowed price tick is a multiple of 1,000 raw,
 * price * size is always divisible by 1e6 for sizes on this quantum. That makes
 * both BUY and SELL CTFExchange amount ratios exact, and granular partial fills
 * leave granular (therefore still exactly representable) remainders.
 */
export const ORDER_SIZE_GRANULARITY_RAW = 1_000n;

export function isAllowedMinimumTickSizeRaw(
  value: bigint,
): value is AllowedMinimumTickSizeRaw {
  return ALLOWED_MINIMUM_TICK_SIZES_RAW.some((tick) => tick === value);
}

export function assertAllowedMinimumTickSizeRaw(
  value: bigint,
): asserts value is AllowedMinimumTickSizeRaw {
  if (!isAllowedMinimumTickSizeRaw(value)) {
    throw new Error(
      `minimumTickSizeRaw must be one of ${ALLOWED_MINIMUM_TICK_SIZES_RAW.join(', ')}`,
    );
  }
  if (ORDER_PRICE_SCALE_RAW % value !== 0n) {
    // Keep the divisibility invariant explicit even though the allow-list is
    // intentionally closed and currently satisfies it by construction.
    throw new Error('minimumTickSizeRaw must divide 1000000 exactly');
  }
}

export type PriceTickFailure =
  | 'NON_POSITIVE'
  | 'ABOVE_MAXIMUM'
  | 'INVALID_TICK'
  | 'OFF_TICK';

/**
 * Keep the independent price-policy checks observable to callers that need to
 * explain a rejection. `isPriceOnTick` remains the compact boolean contract for
 * transaction builders and backend validation.
 */
export function priceTickFailure(
  priceRaw: bigint,
  tickSizeRaw: bigint,
): PriceTickFailure | null {
  if (priceRaw <= 0n) return 'NON_POSITIVE';
  if (priceRaw > ORDER_PRICE_SCALE_RAW) return 'ABOVE_MAXIMUM';
  if (!isAllowedMinimumTickSizeRaw(tickSizeRaw)) return 'INVALID_TICK';
  if (priceRaw % tickSizeRaw !== 0n) return 'OFF_TICK';
  return null;
}

export function isPriceOnTick(priceRaw: bigint, tickSizeRaw: bigint): boolean {
  return priceTickFailure(priceRaw, tickSizeRaw) === null;
}

export function isOrderSizeGranular(sizeRaw: bigint): boolean {
  return sizeRaw > 0n && sizeRaw % ORDER_SIZE_GRANULARITY_RAW === 0n;
}

export function floorOrderSizeToGranularity(sizeRaw: bigint): bigint {
  if (sizeRaw <= 0n) return 0n;
  return sizeRaw - (sizeRaw % ORDER_SIZE_GRANULARITY_RAW);
}

export type TickRounding = 'DOWN' | 'NEAREST' | 'UP';

export function quantizePriceRaw(
  priceRaw: bigint,
  tickSizeRaw: bigint,
  rounding: TickRounding,
): bigint {
  assertAllowedMinimumTickSizeRaw(tickSizeRaw);
  if (priceRaw < 0n || priceRaw > ORDER_PRICE_SCALE_RAW) {
    throw new Error('priceRaw must be between 0 and 1000000');
  }
  const lower = priceRaw - (priceRaw % tickSizeRaw);
  if (rounding === 'DOWN' || lower === priceRaw) return lower;
  const upper = lower + tickSizeRaw;
  if (rounding === 'UP') return upper;
  return priceRaw - lower < upper - priceRaw ? lower : upper;
}

/**
 * A partial fill is safe when it closes the order or leaves a remainder on the
 * global size quantum. This also permits a full fill of legacy awkward dust.
 */
export function leavesRepresentableRemainder(
  remainingRaw: bigint,
  fillSizeRaw: bigint,
): boolean {
  if (remainingRaw <= 0n || fillSizeRaw <= 0n || fillSizeRaw > remainingRaw) {
    return false;
  }
  const after = remainingRaw - fillSizeRaw;
  return after === 0n || after % ORDER_SIZE_GRANULARITY_RAW === 0n;
}

/** Largest fill at or below a requested cap that leaves no unsafe remainder. */
export function fillSizePreservingRepresentableRemainder(
  remainingRaw: bigint,
  requestedRaw: bigint,
): bigint {
  if (remainingRaw <= 0n || requestedRaw <= 0n) return 0n;
  const capped = requestedRaw < remainingRaw ? requestedRaw : remainingRaw;
  if (leavesRepresentableRemainder(remainingRaw, capped)) return capped;
  const residue = remainingRaw % ORDER_SIZE_GRANULARITY_RAW;
  if (capped < residue) return 0n;
  const candidate =
    capped - ((capped - residue) % ORDER_SIZE_GRANULARITY_RAW);
  return leavesRepresentableRemainder(remainingRaw, candidate) ? candidate : 0n;
}
