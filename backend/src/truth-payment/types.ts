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
  resource: {
    url: string;
    description: string;
    mimeType: 'application/json';
  };
  accepts: [TruthPaymentRequirements];
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
  paymentRequiredHeader(resourceUrl: string): string;
  authorize(paymentSignature: string): Promise<TruthPaymentAuthorization>;
}

export function encodePaymentHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function decodePaymentHeader(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
}
