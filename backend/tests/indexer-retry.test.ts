import { HttpRequestError, RpcRequestError, TimeoutError } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  RPC_RETRY_POLICY,
  inspectRpcError,
  retryDelayMs,
} from '../src/indexer/retry.js';

const RPC_URL = 'https://rpc.example.test';

function rpcError(code: number, message: string): RpcRequestError {
  return new RpcRequestError({
    body: { id: 1, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] },
    error: { code, message },
    url: RPC_URL,
  });
}

describe('RPC retry classification and backoff', () => {
  it.each([
    ['viem timeout', () => new TimeoutError({ body: {}, url: RPC_URL })],
    [
      'DNS resolution',
      () =>
        Object.assign(new Error('getaddrinfo ENOTFOUND rpc.example.test'), {
          code: 'ENOTFOUND',
        }),
    ],
    [
      'connection reset',
      () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    ],
  ])('classifies %s failures as transient', (_label, createError) => {
    expect(inspectRpcError(createError())).toMatchObject({
      kind: 'transient',
      retryAfterMs: undefined,
    });
  });

  it.each([
    [-32_005, 'request limit exceeded'],
    [15, 'Public endpoint rate limit'],
    [-32_000, 'You reached Public endpoint rate limit, please upgrade to paid plan'],
  ])('recognizes Arc rate limiting (code %s)', (code, message) => {
    expect(inspectRpcError(rpcError(code, message))).toMatchObject({
      kind: 'rate-limit',
    });
  });

  it('recognizes Arc rate-limit code 15 when nested in RPC data', () => {
    const error = rpcError(-32_000, 'request rejected');
    error.data = { code: 15 };
    expect(inspectRpcError(error)).toMatchObject({ kind: 'rate-limit' });
  });

  it('honors Retry-After while keeping the delay capped', () => {
    const error = new HttpRequestError({
      headers: new Headers({ 'retry-after': '45' }),
      status: 429,
      url: RPC_URL,
    });
    const details = inspectRpcError(error, 1_700_000_000_000);
    expect(details).toMatchObject({ kind: 'rate-limit', retryAfterMs: 45_000 });
    expect(retryDelayMs(1, details!, () => 0)).toBe(45_000);
    expect(retryDelayMs(100, details!, () => 1)).toBe(
      RPC_RETRY_POLICY.maxDelayMs,
    );

    const longRetryAfter = inspectRpcError(
      new HttpRequestError({
        headers: new Headers({ 'retry-after': '120' }),
        status: 429,
        url: RPC_URL,
      }),
      1_700_000_000_000,
    );
    expect(retryDelayMs(1, longRetryAfter!, () => 0)).toBe(120_000);
  });

  it('parses an HTTP-date Retry-After value', () => {
    const now = Date.parse('2026-07-31T00:00:00.000Z');
    const error = new HttpRequestError({
      headers: new Headers({
        'retry-after': new Date(now + 12_000).toUTCString(),
      }),
      status: 503,
      url: RPC_URL,
    });
    expect(inspectRpcError(error, now)).toMatchObject({
      kind: 'transient',
      retryAfterMs: 12_000,
    });
  });

  it('uses a more conservative base for rate limits and caps exponential growth', () => {
    const transient = inspectRpcError(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    const rateLimited = inspectRpcError(rpcError(-32_005, 'rate limit'));

    expect(retryDelayMs(1, transient!, () => 0)).toBe(1_000);
    expect(retryDelayMs(2, transient!, () => 0)).toBe(2_000);
    expect(retryDelayMs(3, transient!, () => 0)).toBe(4_000);
    expect(retryDelayMs(1, rateLimited!, () => 0)).toBe(5_000);
    expect(retryDelayMs(100, transient!, () => 1)).toBe(
      RPC_RETRY_POLICY.maxDelayMs,
    );
  });

  it('does not classify an ordinary application error as retryable RPC failure', () => {
    expect(inspectRpcError(new Error('database constraint failed'))).toBeNull();
  });
});
