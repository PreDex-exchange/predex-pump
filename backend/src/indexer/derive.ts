import type { Address, Hex } from 'viem';

import type { EventArgs, Outcome, Side } from './types.js';

const PRICE_SCALE = 1_000_000n;
const WAD_PER_RAW = 1_000_000_000_000;
const DB_INT_MAX = 2_147_483_647n;

export function lowerAddress(value: Address | string): string {
  return value.toLowerCase();
}

export function decodeQuestion(ancillaryData: Hex): string {
  try {
    const bytes = Buffer.from(ancillaryData.slice(2), 'hex');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0+$/u, '');
    if (decoded.length === 0 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(decoded)) {
      return ancillaryData;
    }
    return decoded;
  } catch {
    return ancillaryData;
  }
}

/**
 * Binary LMSR marginal price:
 * p(YES) = logistic((qYes - qNo) / b).
 *
 * q values use collateral's 6-decimal raw scale and b uses WAD, hence the
 * 1e12 conversion before division. The persisted pair is rounded to 6
 * decimals and forced to sum exactly to 1_000_000.
 */
export function marginalPricesRaw(
  qYesRaw: bigint,
  qNoRaw: bigint,
  bCurrentWad: bigint,
): { yesPriceRaw: string; noPriceRaw: string } {
  if (bCurrentWad <= 0n) {
    return { yesPriceRaw: '500000', noPriceRaw: '500000' };
  }

  const delta = (Number(qYesRaw - qNoRaw) * WAD_PER_RAW) / Number(bCurrentWad);
  let probability: number;
  if (delta >= 40) {
    probability = 1;
  } else if (delta <= -40) {
    probability = 0;
  } else {
    probability = 1 / (1 + Math.exp(-delta));
  }

  // Solidity's WAD-to-collateral conversion floors, so mirror that behavior.
  const yes = BigInt(Math.max(0, Math.min(1_000_000, Math.floor(probability * 1_000_000))));
  return {
    yesPriceRaw: yes.toString(),
    noPriceRaw: (PRICE_SCALE - yes).toString(),
  };
}

export function averagePriceRaw(sizeRaw: bigint, notionalRaw: bigint): string {
  if (sizeRaw <= 0n) {
    return '0';
  }
  return ((notionalRaw * PRICE_SCALE + sizeRaw / 2n) / sizeRaw).toString();
}

export function outcomeFromIndex(value: bigint): Outcome {
  if (value === 0n) return 'YES';
  if (value === 1n) return 'NO';
  throw new Error(`Unsupported binary outcome index ${value}`);
}

export function sideFromIndex(value: bigint): Side {
  if (value === 0n) return 'BID';
  if (value === 1n) return 'ASK';
  throw new Error(`Unsupported side index ${value}`);
}

export function oppositeSide(side: Side): Side {
  return side === 'BID' ? 'ASK' : 'BID';
}

export interface DerivedResolution {
  outcome: 'YES' | 'NO' | 'INVALID';
  payoutYes: number;
  payoutNo: number;
  denominator: number;
}

export function deriveResolution(payouts: readonly bigint[]): DerivedResolution {
  if (payouts.length !== 2) {
    throw new Error(`Expected two binary payouts, received ${payouts.length}`);
  }
  const payoutYes = payouts[0];
  const payoutNo = payouts[1];
  if (payoutYes === undefined || payoutNo === undefined) {
    throw new Error('Missing binary payout');
  }
  const denominator = payoutYes + payoutNo;
  if (denominator <= 0n) {
    throw new Error('Resolution payout denominator must be positive');
  }

  return {
    outcome: payoutYes === payoutNo ? 'INVALID' : payoutYes > payoutNo ? 'YES' : 'NO',
    payoutYes: toDbInt(payoutYes, 'payoutYes'),
    payoutNo: toDbInt(payoutNo, 'payoutNo'),
    denominator: toDbInt(denominator, 'payoutDenominator'),
  };
}

export function toDbInt(value: bigint, field: string): number {
  if (value < 0n || value > DB_INT_MAX) {
    throw new Error(`${field}=${value} does not fit a non-negative Postgres Int`);
  }
  return Number(value);
}

export function bigintArg(args: EventArgs, name: string): bigint {
  const value = args[name];
  if (typeof value === 'bigint') {
    return value;
  }
  // viem intentionally decodes ABI ints <= 48 bits as safe JS numbers.
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new Error(`Expected integer event arg ${name}`);
}

export function stringArg(args: EventArgs, name: string): string {
  const value = args[name];
  if (typeof value !== 'string') {
    throw new Error(`Expected string event arg ${name}`);
  }
  return value;
}

export function booleanArg(args: EventArgs, name: string): boolean {
  const value = args[name];
  if (typeof value !== 'boolean') {
    throw new Error(`Expected boolean event arg ${name}`);
  }
  return value;
}

export function bigintArrayArg(args: EventArgs, name: string): readonly bigint[] {
  const value = args[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'bigint')) {
    throw new Error(`Expected bigint[] event arg ${name}`);
  }
  return value as bigint[];
}

export function tupleArg(args: EventArgs, name: string): Record<string, unknown> {
  const value = args[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected tuple event arg ${name}`);
  }
  return value as Record<string, unknown>;
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]),
    );
  }
  return value;
}
