import { floorOrderSizeToGranularity } from '@predex-pump/shared';
import { formatUnits } from 'viem';

export const ORDER_SIZE_STEP = '0.001';
export const ORDER_SIZE_STEP_ERROR = 'Size must use 0.001 token steps';

export function snappedOrderSizeInput(sizeRaw: bigint): string {
  return formatUnits(floorOrderSizeToGranularity(sizeRaw), 6);
}
