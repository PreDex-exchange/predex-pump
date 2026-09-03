import { createClient } from '@redis/client';

import {
  createDisabledPublicJsonReadCache,
  RedisPublicJsonReadCache,
  type PublicJsonReadCache,
  type RedisCacheTransport,
} from './public-json.js';

export interface NodeRedisPublicJsonCacheOptions {
  url: string | undefined;
  keyPrefix?: string;
}

/** Creates a non-blocking node-redis cache, or a no-op cache when URL is absent. */
export function createNodeRedisPublicJsonReadCache(
  options: NodeRedisPublicJsonCacheOptions,
): PublicJsonReadCache {
  const url = options.url?.trim();
  if (!url) return createDisabledPublicJsonReadCache();

  const client = createClient({ url });
  const transport: RedisCacheTransport = {
    isReady: () => client.isReady,
    isOpen: () => client.isOpen,
    onError: (listener) => {
      client.on('error', listener);
    },
    connect: async () => {
      await client.connect();
    },
    get: (key) => client.get(key),
    setEx: async (key, value, ttlSeconds) => {
      await client.set(key, value, { EX: ttlSeconds });
    },
    increment: (key) => client.incr(key),
    close: async () => {
      await client.close();
    },
    destroy: () => client.destroy(),
  };
  return new RedisPublicJsonReadCache(transport, options.keyPrefix);
}
