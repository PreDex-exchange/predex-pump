import { ADDRESSES, ARC, type ServerEvent } from '@predex-pump/shared';
import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { closeApiRuntime } from '../src/api/runtime.js';
import { ServerEventBus } from '../src/events/bus.js';
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

function bookEvent(reason = 'EXCHANGE_EVENT'): ServerEvent {
  return {
    channel: 'book:1',
    event: 'book.updated',
    data: { marketId: '1', reason: reason as 'EXCHANGE_EVENT' },
  };
}

class FakeRedisBroker {
  readonly subscribers = new Map<string, Set<(message: string) => void>>();
  online = true;
  publishCalls = 0;
  failNextPublish = false;

  createTransport(): FakeRedisTransport {
    return new FakeRedisTransport(this);
  }

  deliver(topic: string, message: string): void {
    for (const listener of this.subscribers.get(topic) ?? []) listener(message);
  }

  async publish(topic: string, message: string): Promise<void> {
    this.publishCalls += 1;
    if (!this.online || this.failNextPublish) {
      this.failNextPublish = false;
      throw new Error('Redis unavailable');
    }
    this.deliver(topic, message);
  }
}

class FakeRedisTransport implements PublicEventTransport {
  readonly errorListeners = new Set<(error: unknown) => void>();
  started = false;
  subscribed = false;
  closed = false;

  constructor(private readonly broker: FakeRedisBroker) {}

  isPublisherReady(): boolean {
    return this.started && !this.closed && this.broker.online;
  }

  isSubscriberReady(): boolean {
    return this.subscribed && !this.closed && this.broker.online;
  }

  onError(listener: (error: unknown) => void): void {
    this.errorListeners.add(listener);
  }

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

function plane(
  broker: FakeRedisBroker,
  producerId: string,
  handlers?: ConstructorParameters<typeof RedisPublicEventPlane>[0]['handlers'],
): RedisPublicEventPlane {
  const result = new RedisPublicEventPlane({
    deployment,
    transport: broker.createTransport(),
    producerId,
    createMessageId: () => `${producerId}-message`,
    ...(handlers === undefined ? {} : { handlers }),
  });
  result.start();
  return result;
}

describe('Redis public event plane', () => {
  it('round-trips nested BigInts and rejects malformed or wrong-deployment envelopes', () => {
    const envelope: IndexedBatchEnvelope = {
      schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
      deployment,
      producerId: 'indexer-1',
      messageId: 'message-1',
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
    ).toThrow('Malformed public-event envelope');
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
    const publisher = plane(broker, 'indexer-1');
    const blocks: number[] = [];
    const delivered = new Promise<void>((resolve) => {
      plane(broker, 'api-1', {
        onServerEvent: () => undefined,
        onIndexedBatch: async (events) => {
          blocks.push(...events.map((event) => event.blockNumber));
          if (blocks.length === MAX_INDEXED_EVENTS_PER_ENVELOPE + 1) resolve();
        },
      });
    });
    const events = Array.from(
      { length: MAX_INDEXED_EVENTS_PER_ENVELOPE + 1 },
      (_, index) => indexedEvent(index + 1),
    );

    await publisher.publishIndexedBatch(events);
    await delivered;

    expect(broker.publishCalls).toBe(2);
    expect(blocks).toEqual(events.map((event) => event.blockNumber));
  });

  it('fans an API event to a second local bus once, ignoring its own Redis echo', async () => {
    const broker = new FakeRedisBroker();
    const firstBus = new ServerEventBus();
    const secondBus = new ServerEventBus();
    const firstDeliveries = vi.fn();
    const secondDeliveries = vi.fn();
    firstBus.subscribe('book:1', firstDeliveries);
    secondBus.subscribe('book:1', secondDeliveries);
    const first = plane(broker, 'api-1', {
      onIndexedBatch: async () => undefined,
      onServerEvent: (event, ts) => firstBus.publish(event, ts),
    });
    const secondReceived = new Promise<void>((resolve) => {
      const second = plane(broker, 'api-2', {
        onIndexedBatch: async () => undefined,
        onServerEvent: (event, ts) => {
          secondBus.publish(event, ts);
          resolve();
        },
      });
      void second;
    });
    const event = bookEvent();

    firstBus.publish(event, 123);
    await first.publishServerEvent(event, 123);
    await secondReceived;

    expect(firstDeliveries).toHaveBeenCalledOnce();
    expect(secondDeliveries).toHaveBeenCalledOnce();
    expect(broker.publishCalls).toBe(1);
    expect(first.getHealth()).toMatchObject({ published: 1, received: 0 });
  });

  it('drops during outage without an offline replay, then delivers only a future event', async () => {
    const broker = new FakeRedisBroker();
    const received: string[] = [];
    const publisher = plane(broker, 'api-1');
    const futureReceived = new Promise<void>((resolve) => {
      plane(broker, 'api-2', {
        onIndexedBatch: async () => undefined,
        onServerEvent: (_event, ts) => {
          received.push(String(ts));
          resolve();
        },
      });
    });

    broker.online = false;
    await publisher.publishServerEvent(bookEvent(), 1);
    broker.online = true;
    await publisher.publishServerEvent(bookEvent(), 2);
    await futureReceived;

    expect(received).toEqual(['2']);
    expect(publisher.getHealth()).toMatchObject({
      status: 'ready',
      published: 1,
      dropped: 1,
    });
  });

  it('rejects bad inbound messages and processes indexed batches sequentially', async () => {
    const broker = new FakeRedisBroker();
    const publisher = plane(broker, 'indexer-1');
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
    const consumer = plane(broker, 'api-1', {
      onServerEvent: () => undefined,
      onIndexedBatch: async (events) => {
        const block = events[0]?.blockNumber;
        order.push(`start-${block}`);
        if (block === 101) {
          firstStarted();
          await firstGate;
        }
        order.push(`end-${block}`);
        if (block === 102) secondFinished();
      },
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
        producerId: 'foreign',
        messageId: 'wrong-deployment',
        kind: 'indexed.batch',
        events: [indexedEvent()],
      }),
    );
    await publisher.publishIndexedBatch([indexedEvent(101)]);
    await publisher.publishIndexedBatch([indexedEvent(102)]);
    await started;
    expect(order).toEqual(['start-101']);
    releaseFirst();
    await finished;

    expect(order).toEqual(['start-101', 'end-101', 'start-102', 'end-102']);
    expect(consumer.getHealth()).toMatchObject({ received: 2, rejected: 2 });
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
          close: (async () => {
            calls.push('app');
            throw new Error('socket close failed');
          }) as Parameters<typeof closeApiRuntime>[0]['app']['close'],
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
