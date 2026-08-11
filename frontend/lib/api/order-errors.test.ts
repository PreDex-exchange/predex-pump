import type { OrderIngestRejectionCode } from '@predex-pump/shared/rest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  humanizeOrderRejection,
  ORDER_REJECTION_MESSAGES,
} from './order-errors';
import { backendRestClient } from './rest-client';

const rejectionCodes = [
  'BAD_SIGNATURE',
  'WRONG_NONCE',
  'EXPIRED',
  'INSUFFICIENT_BALANCE',
  'MISSING_APPROVAL',
  'MARKET_RESOLVED',
  'TOKEN_NOT_REGISTERED',
  'INVALID_PRICE',
  'PRICE_NOT_ON_TICK',
  'INVALID_SIZE',
  'INVALID_FEE',
  'INVALID_TAKER',
  'MALFORMED_ORDER',
  'MARKET_NOT_FOUND',
  'ORDER_HASH_MISMATCH',
  'SIGNER_UNAUTHORIZED',
  'TOKEN_PAIR_MISMATCH',
  'UNSUPPORTED_SIGNATURE_TYPE',
  'CHAIN_READ_FAILED',
] as const satisfies readonly OrderIngestRejectionCode[];

describe('Hybrid order rejection messages', () => {
  it.each(rejectionCodes)('%s becomes distinct human guidance', (code) => {
    const message = humanizeOrderRejection(code);
    expect(message).toBe(ORDER_REJECTION_MESSAGES[code]);
    expect(message).not.toContain(code);
    expect(message).toMatch(/[.!]$/u);
    expect(message.length).toBeGreaterThan(60);
  });

  it('covers the whole contract without sharing one generic message', () => {
    expect(Object.keys(ORDER_REJECTION_MESSAGES).sort()).toEqual(
      [...rejectionCodes].sort(),
    );
    expect(new Set(Object.values(ORDER_REJECTION_MESSAGES)).size).toBe(
      rejectionCodes.length,
    );
  });

  it.each(rejectionCodes)('%s cannot escape through the REST client', async (code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code, message: `machine response ${code}` },
          }),
          {
            status: 422,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );

    const request = backendRestClient.postOrder({
      orderHash: `0x${'11'.repeat(32)}`,
      order: {
        saltRaw: '1',
        maker: `0x${'22'.repeat(20)}`,
        signer: `0x${'22'.repeat(20)}`,
        taker: `0x${'00'.repeat(20)}`,
        tokenId: '101',
        makerAmountRaw: '1',
        takerAmountRaw: '1',
        expiration: 2_000_000_000,
        nonceRaw: '0',
        feeRateBpsRaw: '0',
        side: 0,
        signatureType: 0,
        signature: '0x1234',
      },
    });

    await expect(request).rejects.toMatchObject({
      message: humanizeOrderRejection(code),
    });
    await expect(request).rejects.not.toMatchObject({ message: code });
  });
});

afterEach(() => vi.unstubAllGlobals());
