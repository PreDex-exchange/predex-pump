import {
  encodeAbiParameters,
  hashMessage,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';

import type { ResolutionChoice } from './types';

export const BPS_SCALE = 10_000n;
export const DEADLINE_BUFFER_SECONDS = 20n * 60n;
export const MINI_CLOB_PRICE_SCALE = 1_000_000n;
export const ZERO_COLLECTION_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

const COMMITTEE_DOMAIN_LABEL = 'PredexCommitteeOracleV2';
const RESOLUTION_PAYOUTS: Record<
  ResolutionChoice,
  readonly [bigint, bigint]
> = {
  YES: [1n, 0n],
  NO: [0n, 1n],
  INVALID: [1n, 1n],
};

/** Apply an upper slippage bound, rounding up exactly as the live buy path does. */
export function addSlippage(raw: bigint, slippageBps: number) {
  const bps = BigInt(slippageBps);
  return (raw * (BPS_SCALE + bps) + BPS_SCALE - 1n) / BPS_SCALE;
}

/** Apply a lower slippage bound, rounding down exactly as the live sell path does. */
export function subtractSlippage(raw: bigint, slippageBps: number) {
  const bps = BigInt(slippageBps);
  return (raw * (BPS_SCALE - bps)) / BPS_SCALE;
}

export function deadlineFromTimestamp(
  blockTimestamp: bigint,
  bufferSeconds = DEADLINE_BUFFER_SECONDS,
) {
  return blockTimestamp + bufferSeconds;
}

export function buildMarketMetadata(question: string) {
  const ancillaryData = stringToHex(`${question.trim()}\0`);
  return {
    ancillaryData,
    metadataHash: keccak256(ancillaryData),
  };
}

export function resolutionPayouts(
  outcome: ResolutionChoice,
): readonly [bigint, bigint] {
  return RESOLUTION_PAYOUTS[outcome];
}

export function cumulativeMiniClobPaymentRaw(
  priceRaw: bigint,
  sizeRaw: bigint,
) {
  if (priceRaw < 0n || sizeRaw < 0n) {
    throw new Error('MiniCLOB price and size cannot be negative.');
  }
  if (priceRaw === 0n || sizeRaw === 0n) return 0n;
  return (
    (priceRaw * sizeRaw + MINI_CLOB_PRICE_SCALE - 1n) /
    MINI_CLOB_PRICE_SCALE
  );
}

export function miniClobFillPaymentRaw(
  priceRaw: bigint,
  filledRaw: bigint,
  fillSizeRaw: bigint,
) {
  return (
    cumulativeMiniClobPaymentRaw(priceRaw, filledRaw + fillSizeRaw) -
    cumulativeMiniClobPaymentRaw(priceRaw, filledRaw)
  );
}

export function buildCommitteeResolutionDigest({
  chainId,
  oracle,
  questionId,
  payouts,
  nonce,
}: {
  chainId: number;
  oracle: Address;
  questionId: Hex;
  payouts: readonly [bigint, bigint];
  nonce: bigint;
}) {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [COMMITTEE_DOMAIN_LABEL, BigInt(chainId), oracle],
    ),
  );
  const payloadDigest = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256[]' },
        { type: 'uint256' },
      ],
      [domainSeparator, questionId, [...payouts], nonce],
    ),
  );
  return {
    domainSeparator,
    payloadDigest,
    resolutionDigest: hashMessage({ raw: payloadDigest }),
  };
}
