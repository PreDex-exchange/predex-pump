import { describe, expect, it, vi } from 'vitest';

import {
  RedisPublicJsonReadCache,
  hashPublicCacheIdentity,
  type PublicJsonCacheRequest,
  type RedisCacheTransport,
} from '../src/cache/public-json.js';

interface Payload {
  value: string;
}

function isPayload(value: unknown): value is Payload {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'value' in value &&
    typeof value.value === 'string'
  );
}

class FakeRedisTransport implements RedisCacheTransport {
  readonly values = new Map<string, string>();
  readonly setTtls: number[] = [];
  readonly errorListeners = new Set<(error: unknown) => void>();
  getError: Error | null = null;
  ready = true;
  open = true;
  connectCalls = 0;
  closeCalls = 0;
  destroyCalls = 0;
  connectImplementation: () => Promise<void> = async () => undefined;

  isReady(): boolean {
    return this.ready;
  }

  isOpen(): boolean {
    return this.open;
  }

  onError(listener: (error: unknown) => void): void {
    this.errorListeners.add(listener);
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    await this.connectImplementation();
  }

  async get(key: string): Promise<string | null> {
    if (this.getError !== null) throw this.getError;
    return this.values.get(key) ?? null;
  }

  async setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.values.set(key, value);
    this.setTtls.push(ttlSeconds);
  }

  async increment(key: string): Promise<number> {
    const next = Number(this.values.get(key) ?? '0') + 1;
    this.values.set(key, String(next));
    return next;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.open = false;
    this.ready = false;
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.open = false;
    this.ready = false;
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

function request(
  load: () => Promise<Payload>,
  identity: PublicJsonCacheRequest<Payload>['identity'] = { page: 1 },
): PublicJsonCacheRequest<Payload> {
  return {
    namespace: 'markets',
    identity,
    ttlSeconds: 5,
    validate: isPayload,
    load,
  };
}

describe('Redis public JSON read cache', () => {
  it('misses once, serves a validated hit, records TTL, and closes cleanly', async () => {
    const transport = new FakeRedisTransport();
    const cache = new RedisPublicJsonReadCache(transport, 'test');
    const load = vi.fn(async () => ({ value: 'database' }));

    await expect(cache.getOrLoad(request(load))).resolves.toEqual({ value: 'database' });
    await expect(cache.getOrLoad(request(load))).resolves.toEqual({ value: 'database' });

    expect(load).toHaveBeenCalledOnce();
    expect(transport.setTtls).toEqual([5]);
    expect(transport.errorListeners.size).toBe(1);
    expect(cache.getHealth()).toEqual({
      status: 'ready',
      hits: 1,
      misses: 1,
      errors: 0,
      invalidations: 0,
    });

    await cache.close();
    expect(transport.closeCalls).toBe(1);
    expect(transport.destroyCalls).toBe(0);
  });

  it('hashes identities deterministically and separates every normalized query field', async () => {
    expect(hashPublicCacheIdentity({ phase: 'Opened', limit: 50 })).toBe(
      hashPublicCacheIdentity({ limit: 50, phase: 'Opened' }),
    );

    const transport = new FakeRedisTransport();
    const cache = new RedisPublicJsonReadCache(transport, 'test');
    let loads = 0;
    const load = async (): Promise<Payload> => ({ value: `load-${++loads}` });
    const base = {
      phase: 'Opened',
      creator: '0x1111111111111111111111111111111111111111',
      limit: 50,
      cursor: 'secret-cursor',
    } as const;
    const identities = [
      base,
      { cursor: base.cursor, limit: 50, creator: base.creator, phase: base.phase },
      { ...base, phase: 'Graduated' },
      { ...base, creator: '0x2222222222222222222222222222222222222222' },
      { ...base, limit: 25 },
      { ...base, cursor: 'next-cursor' },
    ];

    for (const identity of identities) await cache.getOrLoad(request(load, identity));

    expect(loads).toBe(5);
    const valueKeys = [...transport.values.keys()];
    expect(valueKeys).toHaveLength(5);
    expect(valueKeys.every((key) => !key.includes(base.creator))).toBe(true);
    expect(valueKeys.every((key) => !key.includes(base.cursor))).toBe(true);
  });

  it('coalesces concurrent same-key misses in one process', async () => {
    const transport = new FakeRedisTransport();
    const cache = new RedisPublicJsonReadCache(transport, 'test');
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const load = vi.fn(async () => {
      started();
      await gate;
      return { value: 'once' };
    });

    const first = cache.getOrLoad(request(load));
    await loadStarted;
    const second = cache.getOrLoad(request(load));
    expect(load).toHaveBeenCalledOnce();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: 'once' },
      { value: 'once' },
    ]);
    expect(load).toHaveBeenCalledOnce();
  });

  it('retries an in-flight load when namespace invalidation advances its epoch', async () => {
    const transport = new FakeRedisTransport();
    const cache = new RedisPublicJsonReadCache(transport, 'test');
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const load = vi
      .fn<() => Promise<Payload>>()
      .mockImplementationOnce(async () => {
        started();
        await gate;
        return { value: 'stale' };
      })
      .mockResolvedValue({ value: 'fresh' });

    const pending = cache.getOrLoad(request(load));
    await loadStarted;
    await cache.invalidate('markets');
    release();

    await expect(pending).resolves.toEqual({ value: 'fresh' });
    expect(load).toHaveBeenCalledTimes(2);
    await expect(cache.getOrLoad(request(load))).resolves.toEqual({ value: 'fresh' });
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.getHealth().invalidations).toBe(1);
  });

  it('repairs an offline invalidation before reusing Redis values', async () => {
    const transport = new FakeRedisTransport();
    const cache = new RedisPublicJsonReadCache(transport, 'test');
    const initialLoad = vi.fn(async () => ({ value: 'old' }));
    await expect(cache.getOrLoad(request(initialLoad))).resolves.toEqual({ value: 'old' });

    transport.ready = false;
    await cache.invalidate('markets');
    transport.ready = true;
    const freshLoad = vi.fn(async () => ({ value: 'fresh' }));

    await expect(cache.getOrLoad(request(freshLoad))).resolves.toEqual({ value: 'fresh' });
    expect(freshLoad).toHaveBeenCalledOnce();
    await expect(cache.getOrLoad(request(freshLoad))).resolves.toEqual({ value: 'fresh' });
    expect(freshLoad).toHaveBeenCalledOnce();
    expect(cache.getHealth()).toMatchObject({
      status: 'ready',
      hits: 1,
      invalidations: 1,
    });
  });

  it('rejects a cached JSON value that fails validation and replaces it', async () => {
    const transport = new FakeRedisTransport();
    const cache = new RedisPublicJsonReadCache(transport, 'test');
    await cache.getOrLoad(request(async () => ({ value: 'initial' })));
    const valueKey = [...transport.values.keys()][0];
    if (valueKey === undefined) throw new Error('Expected a populated cache value');
    transport.values.set(valueKey, JSON.stringify({ unexpected: true }));
    const load = vi.fn(async () => ({ value: 'replacement' }));

    await expect(cache.getOrLoad(request(load))).resolves.toEqual({
      value: 'replacement',
    });
    expect(load).toHaveBeenCalledOnce();
    expect(cache.getHealth().errors).toBe(1);
  });

  it('does not await a background connection before falling through', async () => {
    const transport = new FakeRedisTransport();
    transport.ready = false;
    transport.connectImplementation = () => new Promise<void>(() => undefined);
    const cache = new RedisPublicJsonReadCache(transport, 'test');
    const load = vi.fn(async () => ({ value: 'database' }));

    await expect(cache.getOrLoad(request(load))).resolves.toEqual({ value: 'database' });
    expect(transport.connectCalls).toBe(1);
    expect(load).toHaveBeenCalledOnce();
    expect(cache.getHealth()).toMatchObject({ status: 'degraded', misses: 1 });
    await cache.close();
  });

  it('falls through on Redis command failure and observes client errors', async () => {
    const transport = new FakeRedisTransport();
    const cache = new RedisPublicJsonReadCache(transport, 'test');
    transport.getError = new Error('Redis unavailable');
    const load = vi.fn(async () => ({ value: 'database' }));

    await expect(cache.getOrLoad(request(load))).resolves.toEqual({ value: 'database' });
    expect(load).toHaveBeenCalledOnce();
    expect(cache.getHealth()).toMatchObject({
      status: 'degraded',
      misses: 1,
      errors: 1,
    });

    transport.emitError(new Error('socket reset'));
    expect(cache.getHealth()).toMatchObject({ status: 'degraded', errors: 2 });
  });
});
