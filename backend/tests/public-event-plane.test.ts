import { ADDRESSES, ARC } from '@predex-pump/shared';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { closeApiRuntime } from '../src/api/runtime.js';
import { publishCommittedIndexedEvents } from '../src/events/committed.js';
import {
  decodePublicEventEnvelope,
  encodePublicEventEnvelope,
  MAX_INDEXED_EVENTS_PER_ENVELOPE,
  MAX_PUBLIC_EVENT_BYTES,
  predexPublicEventDeployment,
  publicEventTopic,
  PUBLIC_EVENT_SCHEMA_VERSION,
  RedisPublicEventPlane,
  type IndexedBatchEnvelope,
  type PublicEventDeployment,
  type PublicEventTransport,
} from '../src/events/public-plane.js';
import type { DecodedEvent } from '../src/indexer/types.js';

const deployment = predexPublicEventDeployment('test');

function indexedEvent(blockNumber = 101): DecodedEvent {
  return {
    source: 'LMSR',
    address: ADDRESSES.lmsr as Address,
    eventName: 'TradeState',
    args: {
      marketId: 1n,
      values: [2n, { signed: -3n, ok: true }],
    },
    txHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex,
    logIndex: 4,
    blockNumber,
    ts: 1_700_000_000 + blockNumber,
  };
}

class FakeRedisBroker {
  readonly subscribers = new Map<string, Set<(message: string) => void>>();
  online = true;
  publishCalls = 0;

  createTransport(): FakeRedisTransport {
    return new FakeRedisTransport(this);
  }

  deliver(topic: string, message: string): void {
    for (const listener of this.subscribers.get(topic) ?? []) listener(message);
  }

  async publish(topic: string, message: string): Promise<void> {
    this.publishCalls += 1;
    if (!this.online) throw new Error('Redis unavailable');
    this.deliver(topic, message);
  }
}

class FakeRedisTransport implements PublicEventTransport {
  started = false;
  subscribed = false;
  closed = false;

  constructor(private readonly broker: FakeRedisBroker) {}

  isPublisherReady(): boolean {
    return this.started && !this.subscribed && !this.closed && this.broker.online;
  }

  isSubscriberReady(): boolean {
    return this.subscribed && !this.closed && this.broker.online;
  }

  onError(): void {}

  start(topic: string, onMessage?: (message: string) => void): void {
    this.started = true;
    if (onMessage !== undefined) {
      this.subscribed = true;
      const subscribers = this.broker.subscribers.get(topic) ?? new Set();
      subscribers.add(onMessage);
      this.broker.subscribers.set(topic, subscribers);
    }
  }

  publish(topic: string, message: string): Promise<void> {
    return this.broker.publish(topic, message);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function publisher(broker: FakeRedisBroker): RedisPublicEventPlane {
  const result = new RedisPublicEventPlane({
    role: 'publisher',
    deployment,
    transport: broker.createTransport(),
  });
  result.start();
  return result;
}

function subscriber(
  broker: FakeRedisBroker,
  onIndexedBatch: (events: readonly DecodedEvent[]) => Promise<void>,
): RedisPublicEventPlane {
  const result = new RedisPublicEventPlane({
    role: 'subscriber',
    deployment,
    transport: broker.createTransport(),
    onIndexedBatch,
  });
  result.start();
  return result;
}

describe('Redis indexed-event plane', () => {
  it('round-trips nested BigInts and rejects malformed or wrong-deployment envelopes', () => {
    const envelope: IndexedBatchEnvelope = {
      schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
      deployment,
      kind: 'indexed.batch',
      events: [indexedEvent()],
    };
    const encoded = encodePublicEventEnvelope(envelope);

    expect(decodePublicEventEnvelope(encoded, deployment)).toEqual(envelope);
    expect(publicEventTopic(deployment)).toBe(
      `test:public-events:v1:${ARC.chainId}:${ADDRESSES.registry.toLowerCase()}`,
    );
    expect(() => decodePublicEventEnvelope('{', deployment)).toThrow(
      'not valid JSON',
    );
    expect(() =>
      decodePublicEventEnvelope(
        encoded,
        { ...deployment, registry: `0x${'1'.repeat(40)}` },
      ),
    ).toThrow('wrong schema or deployment');
    expect(() =>
      decodePublicEventEnvelope(
        JSON.stringify({ ...JSON.parse(encoded), unexpected: true }),
        deployment,
      ),
    ).toThrow('wrong schema or deployment');
    expect(() =>
      decodePublicEventEnvelope('x'.repeat(MAX_PUBLIC_EVENT_BYTES + 1), deployment),
    ).toThrow('byte limit');

    let nested: unknown = 1n;
    for (let depth = 0; depth < 34; depth += 1) nested = [nested];
    expect(() =>
      encodePublicEventEnvelope({
        ...envelope,
        events: [{ ...indexedEvent(), args: { nested } }],
      }),
    ).toThrow('nesting is too deep');
  });

  it('chunks a legitimate oversized indexed batch in order', async () => {
    const broker = new FakeRedisBroker();
    const source = publisher(broker);
    const blocks: number[] = [];
    const delivered = new Promise<void>((resolve) => {
      subscriber(broker, async (events) => {
        blocks.push(...events.map((event) => event.blockNumber));
        if (blocks.length === MAX_INDEXED_EVENTS_PER_ENVELOPE + 1) resolve();
      });
    });
    const events = Array.from(
      { length: MAX_INDEXED_EVENTS_PER_ENVELOPE + 1 },
      (_, index) => indexedEvent(index + 1),
    );

    await source.publishIndexedBatch(events);
    await delivered;

    expect(broker.publishCalls).toBe(2);
    expect(blocks).toEqual(events.map((event) => event.blockNumber));
  });

  it('drops during outage without replay, then delivers only a future batch', async () => {
    const broker = new FakeRedisBroker();
    const source = publisher(broker);
    const blocks: number[] = [];
    const futureReceived = new Promise<void>((resolve) => {
      subscriber(broker, async (events) => {
        blocks.push(...events.map((event) => event.blockNumber));
        resolve();
      });
    });

    broker.online = false;
    await source.publishIndexedBatch([indexedEvent(1)]);
    broker.online = true;
    await source.publishIndexedBatch([indexedEvent(2)]);
    await futureReceived;

    expect(blocks).toEqual([2]);
    expect(source.getHealth()).toMatchObject({
      status: 'ready',
      published: 1,
      dropped: 1,
      publisherReady: true,
      subscriberReady: false,
    });
  });

  it('rejects bad inbound messages and processes batches sequentially', async () => {
    const broker = new FakeRedisBroker();
    const source = publisher(broker);
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let secondFinished!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      secondFinished = resolve;
    });
    const consumer = subscriber(broker, async (events) => {
      const block = events[0]?.blockNumber;
      order.push(`start-${block}`);
      if (block === 101) {
        firstStarted();
        await firstGate;
      }
      order.push(`end-${block}`);
      if (block === 102) secondFinished();
    });
    broker.deliver(publicEventTopic(deployment), 'not-json');
    const wrongDeployment: PublicEventDeployment = {
      ...deployment,
      registry: `0x${'2'.repeat(40)}`,
    };
    broker.deliver(
      publicEventTopic(deployment),
      encodePublicEventEnvelope({
        schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
        deployment: wrongDeployment,
        kind: 'indexed.batch',
        events: [indexedEvent()],
      }),
    );
    await source.publishIndexedBatch([indexedEvent(101)]);
    await source.publishIndexedBatch([indexedEvent(102)]);
    await started;
    expect(order).toEqual(['start-101']);
    releaseFirst();
    await finished;

    expect(order).toEqual(['start-101', 'end-101', 'start-102', 'end-102']);
    expect(consumer.getHealth()).toMatchObject({
      received: 2,
      rejected: 2,
      publisherReady: false,
      subscriberReady: true,
    });
  });

  it('invalidates the cache before local and cross-process post-commit fan-out', async () => {
    const calls: string[] = [];
    await publishCommittedIndexedEvents([indexedEvent()], {
      publicReadCache: {
        invalidate: async () => {
          calls.push('invalidate');
        },
      },
      publishLocal: async () => {
        calls.push('local');
      },
      publicEvents: {
        publishIndexedBatch: async () => {
          calls.push('redis');
        },
      },
    });
    expect(calls).toEqual(['invalidate', 'local', 'redis']);
  });

  it('closes every API resource even when an earlier close fails', async () => {
    const calls: string[] = [];
    await expect(
      closeApiRuntime({
        app: {
          close: async () => {
            calls.push('app');
            throw new Error('socket close failed');
          },
        },
        publicEventPlane: {
          close: async () => {
            calls.push('plane');
          },
        },
        publicReadCache: {
          close: async () => {
            calls.push('cache');
          },
        },
        prisma: {
          $disconnect: async () => {
            calls.push('prisma');
          },
        },
      }),
    ).rejects.toThrow('socket close failed');
    expect(calls).toEqual(['app', 'plane', 'cache', 'prisma']);
  });
});
