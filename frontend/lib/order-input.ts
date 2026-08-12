import {
  floorOrderSizeToGranularity,
  ORDER_PRICE_SCALE_RAW,
  priceTickFailure,
  quantizePriceRaw,
} from '@predex-pump/shared';
import { formatUnits } from 'viem';

import { formatPrice, parseUsdcInputResult } from './format';

export const ORDER_SIZE_STEP = '0.001';
export const ORDER_SIZE_STEP_ERROR = 'Size must use 0.001 token steps';

export interface OrderPriceValidation {
  raw: bigint | null;
  error: string | null;
}

function nearestValidPriceRaw(priceRaw: bigint, tickSizeRaw: bigint): bigint {
  const nearest = quantizePriceRaw(priceRaw, tickSizeRaw, 'NEAREST');
  if (nearest <= 0n) return tickSizeRaw;
  if (nearest > ORDER_PRICE_SCALE_RAW) return ORDER_PRICE_SCALE_RAW;
  return nearest;
}

export function validateOrderPriceInput(
  value: string,
  tickSizeRaw: bigint,
): OrderPriceValidation {
  const parsed = parseUsdcInputResult(value);
  if (!parsed.ok) {
    const error = (() => {
      switch (parsed.reason) {
        case 'EMPTY':
          return 'Enter a limit price';
        case 'NEGATIVE':
          return 'Price cannot be negative';
        case 'NON_NUMERIC':
          return 'Enter a numeric price';
        case 'INVALID_FORMAT':
          return 'Enter a price with one decimal point';
        case 'TOO_MANY_DECIMALS':
          return 'Price can use at most six decimal places';
      }
    })();
    return { raw: null, error };
  }

  const raw = BigInt(parsed.raw);
  switch (priceTickFailure(raw, tickSizeRaw)) {
    case 'NON_POSITIVE':
      return { raw, error: 'Price must be greater than 0 USDC' };
    case 'ABOVE_MAXIMUM':
      return { raw, error: 'Price must be at most 1 USDC' };
    case 'INVALID_TICK':
      return { raw, error: 'The market price tick is unavailable' };
    case 'OFF_TICK': {
      const nearest = nearestValidPriceRaw(raw, tickSizeRaw);
      return {
        raw,
        error: `Price must use ${formatUnits(tickSizeRaw, 6)} USDC ticks. Nearest valid price: ${formatPrice(nearest.toString(), 6)}`,
      };
    }
    case null:
      return { raw, error: null };
  }
}

export function snappedOrderSizeInput(sizeRaw: bigint): string {
  return formatUnits(floorOrderSizeToGranularity(sizeRaw), 6);
}
