import {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_VERSION,
} from '@circle-fin/x402-batching';
import {
  CHAIN_CONFIGS,
  GATEWAY_DOMAINS,
} from '@circle-fin/x402-batching/client';
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server';
import { ADDRESSES, ARC } from '@predex-pump/shared';
import { getAddress, type Address } from 'viem';

import {
  decodePaymentHeader,
  encodePaymentHeader,
  type TruthPaymentAuthorization,
  type TruthPaymentGate,
  type TruthPaymentRequired,
  type TruthPaymentRequirements,
} from './types.js';

const ARC_TESTNET_NETWORK = `eip155:${ARC.chainId}`;
const MAX_TIMEOUT_SECONDS = 604_900;
export const DEFAULT_GATEWAY_TESTNET_URL =
  'https://gateway-api-testnet.circle.com';

interface CirclePaymentPayload {
  x402Version: 2;
  resource: TruthPaymentRequired['resource'];
  accepted: TruthPaymentRequirements;
  payload: {
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
    signature: string;
  };
}

interface CircleSettleResult {
  success: boolean;
  errorReason?: string;
  message?: string;
  payer?: string;
  transaction?: string;
  network?: string;
}

export interface CircleFacilitator {
  settle(
    paymentPayload: CirclePaymentPayload,
    requirements: TruthPaymentRequirements,
  ): Promise<CircleSettleResult>;
}

export interface CircleTruthPaymentLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface CircleTruthPaymentGateOptions {
  sellerAddress: Address;
  amountRaw: bigint;
  facilitatorUrl?: string;
  facilitator?: CircleFacilitator;
  logger?: CircleTruthPaymentLogger;
}

const DEFAULT_LOGGER: CircleTruthPaymentLogger = {
  info(fields, message) {
    console.info(`[truth-payment] ${message}`, fields);
  },
  warn(fields, message) {
    console.warn(`[truth-payment] ${message}`, fields);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
}

function acceptedMatches(
  accepted: unknown,
  expected: TruthPaymentRequirements,
): boolean {
  if (!isRecord(accepted) || !isRecord(accepted.extra)) return false;
  return (
    accepted.scheme === expected.scheme &&
    accepted.network === expected.network &&
    sameAddress(accepted.asset, expected.asset) &&
    accepted.amount === expected.amount &&
    sameAddress(accepted.payTo, expected.payTo) &&
    accepted.maxTimeoutSeconds === expected.maxTimeoutSeconds &&
    accepted.extra.name === expected.extra.name &&
    accepted.extra.version === expected.extra.version &&
    sameAddress(
      accepted.extra.verifyingContract,
      expected.extra.verifyingContract,
    )
  );
}

function truthResource(resourceUrl: string): TruthPaymentRequired['resource'] {
  return {
    url: resourceUrl,
    description: 'Predex indexed market-microstructure truth signal',
    mimeType: 'application/json',
  };
}

function resourceMatches(
  resource: unknown,
  expected: TruthPaymentRequired['resource'],
): boolean {
  return (
    isRecord(resource) &&
    resource.url === expected.url &&
    resource.description === expected.description &&
    resource.mimeType === expected.mimeType
  );
}

function resultErrorReason(result: CircleSettleResult): string | undefined {
  if (typeof result.errorReason === 'string') return result.errorReason;
  return typeof result.message === 'string' ? result.message : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Circle facilitator threw a non-Error value.';
}

function redactSignature(
  message: string,
  paymentPayload: CirclePaymentPayload,
): string {
  const { signature } = paymentPayload.payload;
  return signature === ''
    ? message
    : message.replaceAll(signature, '[redacted]');
}

function isPaymentAuthorization(
  value: unknown,
): value is CirclePaymentPayload['payload']['authorization'] {
  return (
    isRecord(value) &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.value === 'string' &&
    typeof value.validAfter === 'string' &&
    typeof value.validBefore === 'string' &&
    typeof value.nonce === 'string'
  );
}

function parsePaymentPayload(encoded: string): CirclePaymentPayload | null {
  let value: unknown;
  try {
    value = decodePaymentHeader(encoded);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.x402Version !== 2 ||
    !isRecord(value.resource) ||
    !isRecord(value.accepted) ||
    !isRecord(value.payload) ||
    !isPaymentAuthorization(value.payload.authorization) ||
    typeof value.payload.signature !== 'string' ||
    value.payload.signature === ''
  ) {
    return null;
  }
  return value as unknown as CirclePaymentPayload;
}

export class CircleTruthPaymentGate implements TruthPaymentGate {
  readonly requirements: TruthPaymentRequirements;
  private readonly facilitator: CircleFacilitator;
  private readonly logger: CircleTruthPaymentLogger;

  constructor(options: CircleTruthPaymentGateOptions) {
    if (options.amountRaw <= 0n || options.amountRaw >= 10_000n) {
      throw new Error(
        'Truth signal price must be between 1 and 9999 raw USDC (strictly sub-cent).',
      );
    }
    const chain = CHAIN_CONFIGS.arcTestnet;
    if (
      GATEWAY_DOMAINS.arcTestnet !== 26 ||
      chain.domain !== 26 ||
      chain.chain.id !== ARC.chainId ||
      !sameAddress(chain.usdc, ADDRESSES.usdc)
    ) {
      throw new Error(
        'Installed Circle SDK Arc Testnet metadata does not match the verified Predex deployment.',
      );
    }
    const sellerAddress = getAddress(options.sellerAddress);
    this.requirements = {
      scheme: 'exact',
      network: ARC_TESTNET_NETWORK,
      asset: chain.usdc,
      amount: options.amountRaw.toString(),
      payTo: sellerAddress,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: {
        name: CIRCLE_BATCHING_NAME,
        version: CIRCLE_BATCHING_VERSION,
        verifyingContract: chain.gatewayWallet,
      },
    };
    this.facilitator =
      options.facilitator ??
      (new BatchFacilitatorClient({
        url: options.facilitatorUrl ?? DEFAULT_GATEWAY_TESTNET_URL,
      }) as unknown as CircleFacilitator);
    this.logger = options.logger ?? DEFAULT_LOGGER;
  }

  paymentRequiredHeader(resourceUrl: string): string {
    const paymentRequired: TruthPaymentRequired = {
      x402Version: 2,
      resource: truthResource(resourceUrl),
      accepts: [this.requirements],
    };
    return encodePaymentHeader(paymentRequired);
  }

  async authorize(
    paymentSignature: string,
    resourceUrl: string,
  ): Promise<TruthPaymentAuthorization> {
    const payload = parsePaymentPayload(paymentSignature);
    if (payload === null) {
      return {
        success: false,
        errorReason: 'Malformed x402 payment signature payload.',
        network: this.requirements.network,
      };
    }
    if (!acceptedMatches(payload.accepted, this.requirements)) {
      return {
        success: false,
        errorReason: 'Payment requirements do not match this truth resource.',
        network: this.requirements.network,
      };
    }
    if (!resourceMatches(payload.resource, truthResource(resourceUrl))) {
      return {
        success: false,
        errorReason: 'Payment resource does not match this truth request.',
        network: this.requirements.network,
      };
    }

    let result: CircleSettleResult;
    try {
      result = await this.facilitator.settle(payload, this.requirements);
    } catch (error) {
      this.logger.warn(
        {
          success: false,
          errorReason: redactSignature(errorMessage(error), payload),
          payer: null,
          transaction: null,
        },
        'Circle truth payment settlement failed',
      );
      throw error;
    }
    const errorReason = resultErrorReason(result);
    const settlementLog = {
      success: result.success,
      errorReason:
        errorReason === undefined
          ? null
          : redactSignature(errorReason, payload),
      payer: result.payer ?? null,
      transaction: result.transaction ?? null,
    };
    if (result.success) {
      this.logger.info(
        settlementLog,
        'Circle truth payment settlement succeeded',
      );
    } else {
      this.logger.warn(
        settlementLog,
        'Circle truth payment settlement rejected',
      );
    }
    return {
      success: result.success,
      ...(errorReason === undefined ? {} : { errorReason }),
      ...(result.payer === undefined ? {} : { payer: result.payer }),
      ...(result.transaction === undefined
        ? {}
        : { transaction: result.transaction }),
      network: result.network || this.requirements.network,
    };
  }
}
