import type { MarketPhase } from '@predex-pump/shared';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const MARKET_PHASES = new Set<MarketPhase>([
  'Opened',
  'Graduated',
  'ResolvedObserved',
  'ClosedOut',
]);

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function parsePositiveInteger(
  name: string,
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || value === '') return fallback;
  if (Array.isArray(value) || (typeof value !== 'string' && typeof value !== 'number')) {
    throw new HttpError(400, `${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new HttpError(400, `${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

export function parseNonNegativeInteger(
  name: string,
  value: unknown,
): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (Array.isArray(value) || (typeof value !== 'string' && typeof value !== 'number')) {
    throw new HttpError(400, `${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(400, `${name} must be a non-negative integer`);
  }
  return parsed;
}

export function parseAddress(name: string, value: unknown): string {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    throw new HttpError(400, `${name} must be a 20-byte hex address`);
  }
  return value.toLowerCase();
}

export function parseOptionalAddress(
  name: string,
  value: unknown,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  return parseAddress(name, value);
}

export function parseDecimalId(name: string, value: unknown): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new HttpError(400, `${name} must be an unsigned decimal string`);
  }
  return value;
}

export function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'cursor must be a string');
  }
  return value;
}

export function parseMarketPhase(value: unknown): MarketPhase | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !MARKET_PHASES.has(value as MarketPhase)) {
    throw new HttpError(400, 'phase is not a valid market phase');
  }
  return value as MarketPhase;
}

interface MarketCursorData {
  kind: 'markets';
  createdAt: number;
  id: string;
}

interface ActivityCursorData {
  kind: 'activity';
  blockNumber: number;
  logIndex: number;
}

export type MarketCursorDataInput = Omit<MarketCursorData, 'kind'>;
export type ActivityCursorDataInput = Omit<ActivityCursorData, 'kind'>;

function encode(value: MarketCursorData | ActivityCursorData): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'cursor is invalid');
  }
}

export function encodeMarketCursor(value: MarketCursorDataInput): string {
  return encode({ kind: 'markets', ...value });
}

export function decodeMarketCursor(value: string): MarketCursorDataInput {
  const decoded = decode(value);
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('kind' in decoded) ||
    decoded.kind !== 'markets' ||
    !('createdAt' in decoded) ||
    typeof decoded.createdAt !== 'number' ||
    !Number.isSafeInteger(decoded.createdAt) ||
    !('id' in decoded) ||
    typeof decoded.id !== 'string' ||
    !DECIMAL_PATTERN.test(decoded.id)
  ) {
    throw new HttpError(400, 'cursor is invalid for markets');
  }
  return { createdAt: decoded.createdAt, id: decoded.id };
}

export function encodeActivityCursor(value: ActivityCursorDataInput): string {
  return encode({ kind: 'activity', ...value });
}

export function decodeActivityCursor(value: string): ActivityCursorDataInput {
  const decoded = decode(value);
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('kind' in decoded) ||
    decoded.kind !== 'activity' ||
    !('blockNumber' in decoded) ||
    typeof decoded.blockNumber !== 'number' ||
    !Number.isSafeInteger(decoded.blockNumber) ||
    !('logIndex' in decoded) ||
    typeof decoded.logIndex !== 'number' ||
    !Number.isSafeInteger(decoded.logIndex)
  ) {
    throw new HttpError(400, 'cursor is invalid for activity');
  }
  return {
    blockNumber: decoded.blockNumber,
    logIndex: decoded.logIndex,
  };
}
