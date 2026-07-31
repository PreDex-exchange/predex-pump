import { BatchEvmScheme } from '@circle-fin/x402-batching/client';
import {
  routes,
  type DedupCheckResponse,
  type TruthSignalResponse,
} from '@predex-pump/shared/rest';

import {
  createRestClient,
  type PredexRestClient,
} from './rest.js';

export class AgentSdkStubError extends Error {
  constructor(surface: string) {
    super(`${surface} is a typed D1 scaffold; its implementation lands later.`);
    this.name = 'AgentSdkStubError';
  }
}

export type {
  DedupCandidate,
  DedupCheckRequest,
  DedupCheckResponse,
} from '@predex-pump/shared';

export type DedupCheck = (
  question: string,
  restClient?: Pick<PredexRestClient, 'dedupCheck'>,
) => Promise<DedupCheckResponse>;

export const dedupCheck: DedupCheck = async (
  question,
  restClient = createRestClient(),
) => {
  try {
    return await restClient.dedupCheck({ question });
  } catch {
    // Keep custom REST-client implementations fail-open too.
    return {
      available: false,
      isDuplicate: false,
      canonicalMarketId: null,
      candidates: [],
    };
  }
};

export interface X402PaymentLimit {
  asset: string;
  maxAmountRaw: bigint;
  network?: string;
}

export interface TruthBuyInput {
  marketId: string;
  payment: X402PaymentLimit;
}

export interface TruthPaymentReceipt {
  paid: boolean;
  amountRaw: bigint;
  asset?: string;
  network?: string;
  transaction?: string;
  payer?: string;
}

export interface TruthBuyResult {
  signal: TruthSignalResponse;
  sourceUrl: string;
  paymentReceipt: TruthPaymentReceipt;
}

export interface TruthClient {
  buy(input: TruthBuyInput): Promise<TruthBuyResult>;
}

export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

interface PaymentRequired {
  x402Version: number;
  resource?: Record<string, unknown>;
  accepts: X402PaymentRequirements[];
}

export interface X402BuyerPaymentProvider {
  createPaymentPayload(
    x402Version: number,
    requirements: X402PaymentRequirements,
  ): Promise<{ x402Version: number; payload: unknown }>;
}

export type CircleX402Signer = ConstructorParameters<typeof BatchEvmScheme>[0];

export function createCircleX402PaymentProvider(
  signer: CircleX402Signer,
): X402BuyerPaymentProvider {
  const scheme = new BatchEvmScheme(signer);
  return {
    async createPaymentPayload(x402Version, requirements) {
      return scheme.createPaymentPayload(x402Version, requirements);
    },
  };
}

export interface TruthClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  paymentProvider?: X402BuyerPaymentProvider;
}

export class TruthPaymentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TruthPaymentUnavailableError';
  }
}

function truthBaseUrl(value: string | undefined): string {
  return (value?.trim() || 'http://localhost:3001').replace(/\/+$/u, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeHeader(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
}

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function paymentRequiredFrom(response: Response): PaymentRequired {
  const encoded = response.headers.get('PAYMENT-REQUIRED');
  if (!encoded) {
    throw new Error('The 402 response did not include PAYMENT-REQUIRED.');
  }
  const decoded = decodeHeader(encoded);
  if (
    !isRecord(decoded) ||
    typeof decoded.x402Version !== 'number' ||
    !Array.isArray(decoded.accepts)
  ) {
    throw new Error('The PAYMENT-REQUIRED header is malformed.');
  }
  return decoded as unknown as PaymentRequired;
}

function isGatewayRequirement(value: unknown): value is X402PaymentRequirements {
  if (!isRecord(value) || !isRecord(value.extra)) return false;
  return (
    value.scheme === 'exact' &&
    typeof value.network === 'string' &&
    typeof value.asset === 'string' &&
    typeof value.amount === 'string' &&
    /^\d+$/u.test(value.amount) &&
    typeof value.payTo === 'string' &&
    typeof value.maxTimeoutSeconds === 'number' &&
    value.extra.name === 'GatewayWalletBatched' &&
    value.extra.version === '1' &&
    typeof value.extra.verifyingContract === 'string'
  );
}

function selectRequirement(
  required: PaymentRequired,
  limit: X402PaymentLimit,
): X402PaymentRequirements {
  const matching = required.accepts.filter(
    (requirement) =>
      isGatewayRequirement(requirement) &&
      requirement.asset.toLowerCase() === limit.asset.toLowerCase() &&
      (limit.network === undefined || requirement.network === limit.network),
  );
  if (matching.length === 0) {
    throw new Error(
      'The truth seller offered no Circle Gateway option matching the configured asset/network.',
    );
  }
  const affordable = matching.find(
    (requirement) =>
      BigInt(requirement.amount) > 0n &&
      BigInt(requirement.amount) <= limit.maxAmountRaw,
  );
  if (affordable === undefined) {
    const requested = matching.map(({ amount }) => amount).join(',');
    throw new Error(
      `Truth payment ${requested} raw exceeds configured maximum ${limit.maxAmountRaw}; refusing without signing.`,
    );
  }
  return affordable;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (isRecord(body) && typeof body.error === 'string') return body.error;
  } catch {
    // Fall through to the HTTP status text.
  }
  return response.statusText || `HTTP ${response.status}`;
}

export function createTruthClient(options: TruthClientOptions = {}): TruthClient {
  const baseUrl = truthBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('A fetch implementation is required.');
  return {
    async buy(input) {
      const sourceUrl = `${baseUrl}${routes.truth(
        encodeURIComponent(input.marketId),
      )}`;
      const headers = { accept: 'application/json' };
      const initial = await fetchImpl(sourceUrl, { headers });
      if (initial.ok) {
        return {
          signal: (await initial.json()) as TruthSignalResponse,
          sourceUrl,
          paymentReceipt: { paid: false, amountRaw: 0n },
        };
      }
      if (initial.status !== 402) {
        throw new Error(
          `Truth request failed before payment: ${await responseError(initial)}`,
        );
      }

      const required = paymentRequiredFrom(initial);
      const selected = selectRequirement(required, input.payment);
      if (options.paymentProvider === undefined) {
        throw new TruthPaymentUnavailableError(
          'Truth endpoint requires payment, but no x402 buyer provider is configured.',
        );
      }
      const payload = await options.paymentProvider.createPaymentPayload(
        required.x402Version,
        selected,
      );
      const paymentSignature = encodeHeader({
        ...payload,
        ...(required.resource === undefined
          ? {}
          : { resource: required.resource }),
        accepted: selected,
      });
      const paid = await fetchImpl(sourceUrl, {
        headers: {
          ...headers,
          'Payment-Signature': paymentSignature,
        },
      });
      if (!paid.ok) {
        throw new Error(`Truth payment failed: ${await responseError(paid)}`);
      }
      const encodedReceipt = paid.headers.get('PAYMENT-RESPONSE');
      const decodedReceipt =
        encodedReceipt === null ? null : decodeHeader(encodedReceipt);
      const receipt = isRecord(decodedReceipt) ? decodedReceipt : {};
      return {
        signal: (await paid.json()) as TruthSignalResponse,
        sourceUrl,
        paymentReceipt: {
          paid: true,
          amountRaw: BigInt(selected.amount),
          asset: selected.asset,
          network: selected.network,
          ...(typeof receipt.transaction === 'string'
            ? { transaction: receipt.transaction }
            : {}),
          ...(typeof receipt.payer === 'string' ? { payer: receipt.payer } : {}),
        },
      };
    },
  };
}

export const truth: TruthClient = createTruthClient();
