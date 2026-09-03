import { createHash } from 'node:crypto';

import type { ReadCacheHealth } from '@predex-pump/shared';

const CACHE_SCHEMA_VERSION = 'v1';
const COMMAND_TIMEOUT_MS = 100;
const MAX_INVALIDATION_RETRIES = 2;
const EPOCH_PATTERN = /^(0|[1-9][0-9]*)$/u;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export type PublicCacheIdentityValue = string | number | boolean | null;
export type PublicCacheIdentity = Readonly<
  Record<string, PublicCacheIdentityValue>
>;

export interface PublicJsonCacheRequest<T> {
  namespace: string;
  identity: PublicCacheIdentity;
  ttlSeconds: number;
  validate(value: unknown): value is T;
  load(): Promise<T>;
}

export interface PublicJsonReadCache {
  getOrLoad<T>(request: PublicJsonCacheRequest<T>): Promise<T>;
  invalidate(namespace: string): Promise<void>;
  getHealth(): ReadCacheHealth;
  close(): Promise<void>;
}

/** Narrow transport seam so cache behavior can be tested without a Redis process. */
export interface RedisCacheTransport {
  isReady(): boolean;
  isOpen(): boolean;
  onError(listener: (error: unknown) => void): void;
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  setEx(key: string, value: string, ttlSeconds: number): Promise<void>;
  increment(key: string): Promise<number>;
  close(): Promise<void>;
  destroy(): void;
}

function assertNamespace(namespace: string): void {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      `Cache namespace must match ${NAMESPACE_PATTERN.source}, received ${namespace}`,
    );
  }
}

function assertTtl(ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`Cache TTL must be a positive integer, received ${ttlSeconds}`);
  }
}

/** Stable and opaque: equivalent identities share a key without leaking query data. */
export function hashPublicCacheIdentity(identity: PublicCacheIdentity): string {
  const canonical = Object.entries(identity)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value]);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function disabledHealth(): ReadCacheHealth {
  return {
    status: 'disabled',
    hits: 0,
    misses: 0,
    errors: 0,
    invalidations: 0,
  };
}

export function createDisabledPublicJsonReadCache(): PublicJsonReadCache {
  return {
    getOrLoad: <T>(request: PublicJsonCacheRequest<T>) => request.load(),
    invalidate: async () => undefined,
    getHealth: disabledHealth,
    close: async () => undefined,
  };
}

function timeoutAfter(milliseconds: number): {
  promise: Promise<never>;
  cancel(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    promise: new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Redis command timed out after ${milliseconds}ms`)),
        milliseconds,
      );
    }),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export class RedisPublicJsonReadCache implements PublicJsonReadCache {
  readonly #inFlight = new Map<string, Promise<unknown>>();
  readonly #localGeneration = new Map<string, number>();
  readonly #dirtyGeneration = new Map<string, number>();
  readonly #repairInFlight = new Map<string, Promise<void>>();
  readonly #keyPrefix: string;
  readonly #health: ReadCacheHealth = {
    status: 'degraded',
    hits: 0,
    misses: 0,
    errors: 0,
    invalidations: 0,
  };
  #closing = false;

  constructor(
    private readonly transport: RedisCacheTransport,
    keyPrefix = 'predex',
  ) {
    const normalizedPrefix = keyPrefix.trim().replace(/:+$/u, '');
    if (normalizedPrefix === '') throw new Error('Redis key prefix cannot be empty');
    this.#keyPrefix = `${normalizedPrefix}:public-json:${CACHE_SCHEMA_VERSION}`;

    // node-redis requires an error listener; without one, a socket error can
    // become an uncaught process error. Attach it before starting connection.
    this.transport.onError(() => this.recordError());
    if (this.transport.isReady()) {
      this.#health.status = 'ready';
    } else {
      void this.transport
        .connect()
        .then(() => {
          if (!this.#closing && this.transport.isReady()) this.#health.status = 'ready';
        })
        .catch(() => {
          if (!this.#closing) this.recordError();
        });
    }
  }

  getHealth(): ReadCacheHealth {
    return { ...this.#health };
  }

  async getOrLoad<T>(request: PublicJsonCacheRequest<T>): Promise<T> {
    assertNamespace(request.namespace);
    assertTtl(request.ttlSeconds);
    const digest = hashPublicCacheIdentity(request.identity);
    const generation = this.generation(request.namespace);
    const inFlightKey = `${request.namespace}:${generation}:${digest}`;
    const existing = this.#inFlight.get(inFlightKey) as Promise<T> | undefined;
    if (existing !== undefined) return existing;

    const pending = this.loadResilient(request, digest);
    this.#inFlight.set(inFlightKey, pending);
    try {
      return await pending;
    } finally {
      if (this.#inFlight.get(inFlightKey) === pending) {
        this.#inFlight.delete(inFlightKey);
      }
    }
  }

  async invalidate(namespace: string): Promise<void> {
    assertNamespace(namespace);
    this.#health.invalidations += 1;
    const generation = this.generation(namespace) + 1;
    this.#localGeneration.set(namespace, generation);
    this.#dirtyGeneration.set(namespace, generation);
    if (!this.transport.isReady() || this.#closing) {
      this.#health.status = 'degraded';
      return;
    }
    await this.repairNamespace(namespace);
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    if (!this.transport.isOpen()) return;
    try {
      const timeout = timeoutAfter(1_000);
      try {
        await Promise.race([this.transport.close(), timeout.promise]);
      } finally {
        timeout.cancel();
      }
    } catch {
      this.transport.destroy();
    }
  }

  private generation(namespace: string): number {
    return this.#localGeneration.get(namespace) ?? 0;
  }

  private epochKey(namespace: string): string {
    return `${this.#keyPrefix}:${namespace}:epoch`;
  }

  private valueKey(namespace: string, epoch: string, digest: string): string {
    return `${this.#keyPrefix}:${namespace}:${epoch}:${digest}`;
  }

  private async command<T>(operation: () => Promise<T>): Promise<T> {
    const timeout = timeoutAfter(COMMAND_TIMEOUT_MS);
    try {
      return await Promise.race([operation(), timeout.promise]);
    } finally {
      timeout.cancel();
    }
  }

  private async readEpoch(namespace: string): Promise<string> {
    const raw = await this.command(() => this.transport.get(this.epochKey(namespace)));
    const epoch = raw ?? '0';
    if (!EPOCH_PATTERN.test(epoch)) {
      throw new Error(`Redis cache epoch is malformed for namespace ${namespace}`);
    }
    this.recordSuccess();
    return epoch;
  }

  private async loadResilient<T>(
    request: PublicJsonCacheRequest<T>,
    digest: string,
  ): Promise<T> {
    for (let attempt = 0; attempt <= MAX_INVALIDATION_RETRIES; attempt += 1) {
      if (!this.transport.isReady() || this.#closing) {
        this.#health.status = 'degraded';
        this.#health.misses += 1;
        return request.load();
      }
      if (
        this.#dirtyGeneration.has(request.namespace) &&
        !(await this.repairNamespace(request.namespace))
      ) {
        this.#health.status = 'degraded';
        this.#health.misses += 1;
        return request.load();
      }
      const generation = this.generation(request.namespace);
      if (this.#dirtyGeneration.has(request.namespace)) continue;

      let epoch: string;
      try {
        epoch = await this.readEpoch(request.namespace);
      } catch {
        this.recordError();
        this.#health.misses += 1;
        return request.load();
      }
      if (
        generation !== this.generation(request.namespace) ||
        this.#dirtyGeneration.has(request.namespace)
      ) {
        continue;
      }

      const key = this.valueKey(request.namespace, epoch, digest);
      let raw: string | null;
      try {
        raw = await this.command(() => this.transport.get(key));
        this.recordSuccess();
      } catch {
        this.recordError();
        this.#health.misses += 1;
        return request.load();
      }

      if (raw !== null) {
        let parsed: T | undefined;
        try {
          const candidate = JSON.parse(raw) as unknown;
          if (request.validate(candidate)) parsed = candidate;
        } catch {
          parsed = undefined;
        }
        if (parsed !== undefined) {
          try {
            const currentEpoch = await this.readEpoch(request.namespace);
            if (
              currentEpoch === epoch &&
              generation === this.generation(request.namespace) &&
              !this.#dirtyGeneration.has(request.namespace)
            ) {
              this.#health.hits += 1;
              return parsed;
            }
            continue;
          } catch {
            this.recordError();
            this.#health.misses += 1;
            return request.load();
          }
        }
        this.recordError();
      }

      this.#health.misses += 1;
      const loaded = await request.load();
      if (
        generation !== this.generation(request.namespace) ||
        this.#dirtyGeneration.has(request.namespace)
      ) {
        continue;
      }

      let currentEpoch: string;
      try {
        currentEpoch = await this.readEpoch(request.namespace);
      } catch {
        this.recordError();
        return loaded;
      }
      if (
        currentEpoch !== epoch ||
        generation !== this.generation(request.namespace) ||
        this.#dirtyGeneration.has(request.namespace)
      ) {
        continue;
      }

      try {
        await this.command(() =>
          this.transport.setEx(key, JSON.stringify(loaded), request.ttlSeconds),
        );
        this.recordSuccess();
      } catch {
        this.recordError();
      }
      return loaded;
    }

    // Continuous invalidation is unusual; bound retries and prefer a fresh
    // authoritative read over delaying the caller indefinitely.
    this.#health.misses += 1;
    return request.load();
  }

  private async repairNamespace(namespace: string): Promise<boolean> {
    const dirtyGeneration = this.#dirtyGeneration.get(namespace);
    if (dirtyGeneration === undefined) return true;
    if (!this.transport.isReady() || this.#closing) return false;

    const existing = this.#repairInFlight.get(namespace);
    if (existing !== undefined) {
      await existing;
      return !this.#dirtyGeneration.has(namespace);
    }

    const repair = (async () => {
      try {
        await this.command(() => this.transport.increment(this.epochKey(namespace)));
        this.recordSuccess();
        if (this.#dirtyGeneration.get(namespace) === dirtyGeneration) {
          this.#dirtyGeneration.delete(namespace);
        } else {
          // Another invalidation raced this INCR. Its generation must remain
          // dirty until a later repair advances the remote epoch again.
          this.#health.status = 'degraded';
        }
      } catch {
        this.recordError();
      }
    })();
    this.#repairInFlight.set(namespace, repair);
    try {
      await repair;
    } finally {
      if (this.#repairInFlight.get(namespace) === repair) {
        this.#repairInFlight.delete(namespace);
      }
    }
    return !this.#dirtyGeneration.has(namespace);
  }

  private recordSuccess(): void {
    if (!this.#closing) this.#health.status = 'ready';
  }

  private recordError(): void {
    this.#health.errors += 1;
    if (!this.#closing) this.#health.status = 'degraded';
  }
}
