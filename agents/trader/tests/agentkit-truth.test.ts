import { ADDRESSES, ARC, type TruthSignalResponse } from '@predex-pump/shared';
import { buildAgentkitSchema } from '@worldcoin/agentkit';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { createAgentkitTruthClient } from '../src/agentkit-truth.js';

const ACCOUNT = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const SOURCE_URL = 'https://api.predex.test/truth/5';
const TRANSACTION = `0x${'ab'.repeat(32)}`;
const SIGNAL = {
  marketId: '5',
  estimateType: 'INDEXED_MARKET_ESTIMATE',
  fairValueYesRaw: '528213',
  fairValueNoRaw: '471787',
} as TruthSignalResponse;

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function paymentRequired(nonce: number, amount = '100'): Response {
  const challenge = {
    x402Version: 2,
    error: 'Payment required for this truth signal.',
    resource: {
      url: '/truth/5',
      description: 'Predex truth signal',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: `eip155:${ARC.chainId}`,
        asset: ADDRESSES.usdc,
        amount,
        payTo: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        maxTimeoutSeconds: 604_900,
        extra: {
          name: 'GatewayWalletBatched',
          version: '1',
          verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
        },
      },
    ],
    extensions: {
      agentkit: {
        info: {
          domain: 'api.predex.test',
          uri: SOURCE_URL,
          version: '1',
          nonce: nonce.toString(16).padStart(32, '0'),
          issuedAt: new Date().toISOString(),
          expirationTime: new Date(Date.now() + 300_000).toISOString(),
          resources: [SOURCE_URL],
          statement:
            'Verify this Continuity trading agent is backed by a unique human',
        },
        supportedChains: [
          { chainId: `eip155:${ARC.chainId}`, type: 'eip191' },
        ],
        schema: buildAgentkitSchema(),
        mode: { type: 'free-trial', uses: 3 },
      },
    },
  };
  return new Response(JSON.stringify(challenge), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'PAYMENT-REQUIRED': encoded(challenge),
    },
  });
}

describe('trader World AgentKit truth transport', () => {
  it('uses three human-backed reads before the existing Circle fallback', async () => {
    let challengeNonce = 0;
    let freeUses = 0;
    let agentkitHeaders = 0;
    let paymentHeaders = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.has('Payment-Signature')) {
        paymentHeaders += 1;
        return new Response(JSON.stringify(SIGNAL), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'PAYMENT-RESPONSE': encoded({
              success: true,
              payer: ACCOUNT.address,
              transaction: TRANSACTION,
              network: `eip155:${ARC.chainId}`,
            }),
            'x-predex-truth-access': 'circle-x402',
          },
        });
      }
      if (request.headers.has('agentkit')) {
        agentkitHeaders += 1;
        if (freeUses < 3) {
          freeUses += 1;
          return new Response(JSON.stringify(SIGNAL), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-predex-truth-access': 'world-agentkit',
            },
          });
        }
      }
      challengeNonce += 1;
      return paymentRequired(challengeNonce);
    });
    const client = createAgentkitTruthClient({
      account: ACCOUNT,
      baseUrl: 'https://api.predex.test',
      fetch,
    });

    const receipts = [];
    for (let call = 0; call < 4; call += 1) {
      const result = await client.buy({
        marketId: '5',
        payment: {
          asset: ADDRESSES.usdc,
          network: `eip155:${ARC.chainId}`,
          maxAmountRaw: 100n,
        },
      });
      receipts.push(result.paymentReceipt);
    }

    expect(receipts.slice(0, 3)).toEqual([
      { paid: false, amountRaw: 0n, access: 'world-agentkit' },
      { paid: false, amountRaw: 0n, access: 'world-agentkit' },
      { paid: false, amountRaw: 0n, access: 'world-agentkit' },
    ]);
    expect(receipts[3]).toMatchObject({
      paid: true,
      amountRaw: 100n,
      access: 'circle-x402',
      transaction: TRANSACTION,
      payer: ACCOUNT.address,
    });
    expect(agentkitHeaders).toBe(4);
    expect(paymentHeaders).toBe(1);
  });

  it('automatically pays when AgentBook does not grant the trial', async () => {
    let challengeNonce = 0;
    let paymentHeaders = 0;
    let agentkitHeaders = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.has('Payment-Signature')) {
        paymentHeaders += 1;
        return new Response(JSON.stringify(SIGNAL), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'PAYMENT-RESPONSE': encoded({
              success: true,
              payer: ACCOUNT.address,
              transaction: TRANSACTION,
              network: `eip155:${ARC.chainId}`,
            }),
          },
        });
      }
      if (request.headers.has('agentkit')) agentkitHeaders += 1;
      challengeNonce += 1;
      return paymentRequired(challengeNonce);
    });
    const client = createAgentkitTruthClient({
      account: ACCOUNT,
      baseUrl: 'https://api.predex.test',
      fetch,
    });

    const result = await client.buy({
      marketId: '5',
      payment: {
        asset: ADDRESSES.usdc,
        network: `eip155:${ARC.chainId}`,
        maxAmountRaw: 100n,
      },
    });

    expect(result.paymentReceipt).toMatchObject({
      paid: true,
      amountRaw: 100n,
      access: 'circle-x402',
    });
    expect(agentkitHeaders).toBe(1);
    expect(paymentHeaders).toBe(1);
  });

  it('refuses an above-cap fallback before sending a Circle payment', async () => {
    let challengeNonce = 0;
    let paymentHeaders = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.has('Payment-Signature')) paymentHeaders += 1;
      challengeNonce += 1;
      return paymentRequired(challengeNonce, '101');
    });
    const client = createAgentkitTruthClient({
      account: ACCOUNT,
      baseUrl: 'https://api.predex.test',
      fetch,
    });

    await expect(
      client.buy({
        marketId: '5',
        payment: {
          asset: ADDRESSES.usdc,
          network: `eip155:${ARC.chainId}`,
          maxAmountRaw: 100n,
        },
      }),
    ).rejects.toThrow(/exceeds configured maximum/u);
    expect(paymentHeaders).toBe(0);
  });
});
