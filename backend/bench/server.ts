import type { ServerEvent } from '@predex-pump/shared';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../src/api/server.js';
import { createNodeRedisPublicJsonReadCache } from '../src/cache/node-redis.js';
import { loadRuntimeConfig } from '../src/config.js';
import { ServerEventBus } from '../src/events/bus.js';
import {
  parseBenchmarkServerRequest,
  type BenchmarkServerMessage,
  type PublishDistribution,
} from './protocol.js';
import { makePrisma } from './support.js';

const databaseUrl = process.env.PREDEX_BENCH_SERVER_DATABASE_URL;

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1,
  );
  return sorted[index] ?? 0;
}

function distribution(samples: readonly number[]): {
  p50: number;
  p95: number;
  p99: number;
} {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForRedis(
  cache: ReturnType<typeof createNodeRedisPublicJsonReadCache>,
  configured: boolean,
): Promise<void> {
  if (!configured) return;
  const deadline = Date.now() + 10_000;
  while (cache.getHealth().status !== 'ready') {
    if (Date.now() >= deadline) {
      throw new Error('Benchmark Redis did not become ready within 10000ms');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function send(message: BenchmarkServerMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined || !process.connected) {
      reject(new Error('Benchmark parent IPC channel is unavailable'));
      return;
    }
    process.send(message, undefined, undefined, (error: Error | null) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function publishEvents(
  eventBus: ServerEventBus,
  eventCount: number,
  baseTimestamp: number,
): PublishDistribution {
  const event: ServerEvent = {
    channel: 'market:bench-target',
    event: 'price.tick',
    data: {
      marketId: 'bench-target',
      yesPriceRaw: '500000',
      noPriceRaw: '500000',
      ts: baseTimestamp,
    },
  };
  const samples: number[] = [];
  for (let index = 0; index < eventCount; index += 1) {
    const startedAt = performance.now();
    eventBus.publish(event, baseTimestamp + index);
    samples.push((performance.now() - startedAt) * 1_000);
  }
  const publishDurationMs =
    samples.reduce((sum, value) => sum + value, 0) / 1_000;
  const stats = distribution(samples);
  return {
    publishP50Us: stats.p50,
    publishP95Us: stats.p95,
    publishP99Us: stats.p99,
    publishDurationMs,
    publishesPerSecond: eventCount / (publishDurationMs / 1_000),
  };
}

async function main(): Promise<void> {
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('PREDEX_BENCH_SERVER_DATABASE_URL is required');
  }
  if (process.send === undefined || !process.connected) {
    throw new Error('Benchmark server must run as an IPC child');
  }

  const config = loadRuntimeConfig();
  const prisma = makePrisma(databaseUrl);
  const eventBus = new ServerEventBus();
  const publicReadCache = createNodeRedisPublicJsonReadCache({
    url: config.redisUrl,
    keyPrefix: config.redisKeyPrefix,
  });
  let app: FastifyInstance | undefined;
  let closePromise: Promise<void> | undefined;

  const close = (exitCode: number): Promise<void> => {
    closePromise ??= (async () => {
      const cleanupErrors: string[] = [];
      try {
        if (app !== undefined) await app.close();
      } catch (error) {
        cleanupErrors.push(`Fastify close: ${errorMessage(error)}`);
      }
      try {
        await publicReadCache.close();
      } catch (error) {
        cleanupErrors.push(`Redis close: ${errorMessage(error)}`);
      }
      try {
        await prisma.$disconnect();
      } catch (error) {
        cleanupErrors.push(`Prisma disconnect: ${errorMessage(error)}`);
      }
      if (process.connected) {
        if (cleanupErrors.length > 0) {
          await send({
            type: 'fatal',
            message: `Benchmark server cleanup failed: ${cleanupErrors.join('; ')}`,
          }).catch(() => undefined);
        }
        await send({ type: 'stopped' }).catch(() => undefined);
        process.disconnect();
      }
      process.exitCode = cleanupErrors.length > 0 ? 1 : exitCode;
    })();
    return closePromise;
  };

  const fail = async (error: unknown): Promise<void> => {
    if (process.connected) {
      await send({ type: 'fatal', message: errorMessage(error) }).catch(
        () => undefined,
      );
    }
    await close(1);
  };

  process.once('SIGINT', () => void close(0));
  process.once('SIGTERM', () => void close(0));
  process.once('disconnect', () => void close(0));

  try {
    await waitForRedis(publicReadCache, config.redisUrl !== undefined);
    app = await buildServer({
      prisma,
      eventBus,
      logger: false,
      publicReadCache,
      marketListCacheTtlSeconds: config.marketsCacheTtlSeconds,
    });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    process.on('message', (value: unknown) => {
      void (async () => {
        const request = parseBenchmarkServerRequest(value);
        if (request.type === 'shutdown') {
          await close(0);
          return;
        }
        await send({
          type: 'publish-result',
          requestId: request.requestId,
          result: publishEvents(
            eventBus,
            request.eventCount,
            request.baseTimestamp,
          ),
        });
      })().catch(fail);
    });
    await send({
      type: 'ready',
      pid: process.pid,
      baseUrl,
      websocketUrl: `${baseUrl.replace(/^http/u, 'ws')}/ws`,
      redisConfigured: config.redisUrl !== undefined,
    });
  } catch (error) {
    await fail(error);
  }
}

void main().catch(async (error: unknown) => {
  if (process.connected) {
    await send({ type: 'fatal', message: errorMessage(error) }).catch(
      () => undefined,
    );
    process.disconnect();
  }
  process.exitCode = 1;
});
