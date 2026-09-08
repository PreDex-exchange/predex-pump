export const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
export const PAYMENT_SIGNATURE_HEADER = 'payment-signature';
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

export interface TruthPaymentRequirements {
  scheme: 'exact';
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    name: 'GatewayWalletBatched';
    version: '1';
    verifyingContract: string;
  };
}

export interface TruthPaymentRequired {
  x402Version: 2;
  error?: string;
  resource: {
    url: string;
    description: string;
    mimeType: 'application/json';
  };
  accepts: [TruthPaymentRequirements];
  extensions?: Record<string, unknown>;
}

export interface TruthPaymentAuthorization {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string;
  network: string;
}

/** Framework-neutral seam; production uses Circle and tests inject a fake facilitator. */
export interface TruthPaymentGate {
  readonly requirements: TruthPaymentRequirements;
  paymentRequired(resourceUrl: string): TruthPaymentRequired;
  paymentRequiredHeader(resourceUrl: string): string;
  authorize(
    paymentSignature: string,
    resourceUrl: string,
  ): Promise<TruthPaymentAuthorization>;
}

/** Optional World AgentKit trial layered before the existing Circle payment. */
export interface TruthAgentTrialGate {
  paymentRequiredExtensions(
    resourcePath: string,
    paymentRequired: TruthPaymentRequired,
  ): Promise<Record<string, unknown>>;
  authorize(header: string, resourcePath: string): Promise<boolean>;
}

export function encodePaymentHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function decodePaymentHeader(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
}
