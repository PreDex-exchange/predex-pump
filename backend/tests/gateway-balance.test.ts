import { describe, expect, it, vi } from 'vitest';

import { CircleGatewayBalanceReader } from '../src/gateway/balance.js';

const ADDRESS = `0x${'12'.repeat(20)}` as const;

describe('Circle Gateway plain balance reader', () => {
  it('matches the installed SDK balance request and total calculation', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          balances: [
            {
              balance: '2.000001',
              withdrawing: '0.500000',
              withdrawable: '0.250000',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const reader = new CircleGatewayBalanceReader({
      apiUrl: 'https://gateway.example',
      fetchImpl,
    });

    await expect(reader.read(ADDRESS)).resolves.toEqual({
      availableRaw: '2000001',
      totalRaw: '2500001',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gateway.example/v1/balances',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          token: 'USDC',
          sources: [{ depositor: ADDRESS, domain: 26 }],
        }),
      }),
    );
  });

  it('fails closed on malformed Circle data', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ balances: [{ balance: 'not-money' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const reader = new CircleGatewayBalanceReader({ fetchImpl });

    await expect(reader.read(ADDRESS)).rejects.toThrow(
      'Circle Gateway balance is temporarily unavailable.',
    );
  });
});
