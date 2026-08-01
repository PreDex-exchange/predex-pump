import type { GatewayBalanceResponse } from '@predex-pump/shared';
import { CIRCLE_GATEWAY_DOMAIN } from '@predex-pump/shared/tx';
import { parseUnits, type Address } from 'viem';

const DEFAULT_GATEWAY_API_URL = 'https://gateway-api-testnet.circle.com';
const DEFAULT_TIMEOUT_MS = 5_000;
const DECIMAL_USDC = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/u;

export interface GatewayBalanceReader {
  read(address: Address): Promise<GatewayBalanceResponse>;
}

interface CircleGatewayBalanceReaderOptions {
  apiUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function usdcRaw(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !DECIMAL_USDC.test(value)) {
    throw new Error(`Circle Gateway returned an invalid ${field} balance.`);
  }
  return parseUnits(value, 6);
}

function balancesUrl(apiUrl: string): string {
  const normalized = apiUrl.replace(/\/+$/u, '');
  return `${normalized.endsWith('/v1') ? normalized : `${normalized}/v1`}/balances`;
}

/**
 * Plain read equivalent to GatewayClient.getBalance(address), without creating
 * the private-key-only SDK client. No response is persisted by Predex.
 */
export class CircleGatewayBalanceReader implements GatewayBalanceReader {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CircleGatewayBalanceReaderOptions = {}) {
    this.apiUrl =
      options.apiUrl?.trim() ||
      process.env.PREDEX_GATEWAY_FACILITATOR_URL?.trim() ||
      DEFAULT_GATEWAY_API_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async read(address: Address): Promise<GatewayBalanceResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(balancesUrl(this.apiUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: 'USDC',
          sources: [{ depositor: address, domain: CIRCLE_GATEWAY_DOMAIN }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Circle Gateway balance service returned HTTP ${response.status}.`,
        );
      }
      const data: unknown = await response.json();
      if (!isRecord(data) || !Array.isArray(data.balances)) {
        throw new Error('Circle Gateway returned no balance list.');
      }
      const first = data.balances[0];
      if (!isRecord(first)) {
        throw new Error('Circle Gateway returned no balance for this address.');
      }
      const available = usdcRaw(first.balance, 'available');
      const withdrawing = usdcRaw(first.withdrawing ?? '0', 'withdrawing');
      return {
        availableRaw: available.toString(),
        totalRaw: (available + withdrawing).toString(),
      };
    } catch (error) {
      throw new Error('Circle Gateway balance is temporarily unavailable.', {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
