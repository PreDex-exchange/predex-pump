import type { ListMarketsResponse } from '@predex-pump/shared';

const MARKET_PHASES = new Set([
  'Opened',
  'Graduated',
  'ResolvedObserved',
  'ClosedOut',
]);
const RESOLUTION_OUTCOMES = new Set(['YES', 'NO', 'INVALID']);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(record: JsonRecord, fields: readonly string[]): boolean {
  return fields.every((field) => typeof record[field] === 'string');
}

function integers(record: JsonRecord, fields: readonly string[]): boolean {
  return fields.every((field) => {
    const value = record[field];
    return typeof value === 'number' && Number.isSafeInteger(value);
  });
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function nullableInteger(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

function isResolution(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    strings(value, ['marketId', 'conditionId']) &&
    typeof value.outcome === 'string' &&
    RESOLUTION_OUTCOMES.has(value.outcome) &&
    integers(value, ['payoutYes', 'payoutNo', 'denominator', 'resolvedAt']) &&
    nullableInteger(value.observedAt)
  );
}

function isMarket(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.params)) return false;
  const resolution = value.resolution;
  return (
    strings(value, [
      'id',
      'creator',
      'question',
      'conditionId',
      'questionId',
      'yesTokenId',
      'noTokenId',
      'seedRaw',
      'yesPriceRaw',
      'noPriceRaw',
      'graduationActivityRaw',
      'volumeRaw',
    ]) &&
    typeof value.phase === 'string' &&
    MARKET_PHASES.has(value.phase) &&
    nullableString(value.bookAddress) &&
    nullableString(value.frozenYesPriceRaw) &&
    nullableString(value.handoffSizeRaw) &&
    integers(value, ['tradeCount', 'createdAt', 'tradingEndsAt']) &&
    nullableInteger(value.graduatedAt) &&
    nullableInteger(value.resolvedAt) &&
    strings(value.params, [
      'seedFloorRaw',
      'seedCapRaw',
      'fCapRaw',
      'graduationMoneyInThresholdRaw',
      'graduationTollRaw',
      'inventoryTargetRaw',
      'minimumTickSizeRaw',
    ]) &&
    integers(value.params, [
      'protocolFeeBps',
      'depthFeeBps',
      'tradingWindowSeconds',
      'minimumTimeOpenSeconds',
    ]) &&
    (resolution === undefined || resolution === null || isResolution(resolution))
  );
}

/** Rejects stale/corrupt/foreign Redis values before they reach the public API. */
export function isListMarketsResponse(value: unknown): value is ListMarketsResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.length <= 200 &&
    value.items.every(isMarket) &&
    (value.nextCursor === null || typeof value.nextCursor === 'string')
  );
}
