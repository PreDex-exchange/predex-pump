import { createClient } from '@redis/client';

import type { DecodedEvent } from '../indexer/types.js';

import {
  createDisabledIndexedEventPublisher,
  createDisabledIndexedEventSubscriber,
  RedisPublicEventPlane,
  type IndexedEventPublisher,
  type IndexedEventSubscriber,
  type PublicEventDeployment,
  type PublicEventTransport,
} from './public-plane.js';

interface NodeRedisPublicEventOptions {
  url: string | undefined;
  deployment: PublicEventDeployment;
}

interface NodeRedisSubscriberOptions extends NodeRedisPublicEventOptions {
  onIndexedBatch(events: readonly DecodedEvent[]): Promise<void>;
}

export function createNodeRedisPublicEventTransport(
  url: string,
  role: 'publisher' | 'subscriber',
): PublicEventTransport {
  // A process creates only the connection its role needs. The publisher's
  // offline queue is disabled so recovery emits future notifications only.
  const client = createClient({ url, disableOfflineQueue: true });
  const errorListeners = new Set<(error: unknown) => void>();
  const reportError = (error: unknown): void => {
    for (const listener of errorListeners) listener(error);
  };
  client.on('error', reportError);
  let started = false;
  let closing = false;
  let connectionRun: Promise<void> | undefined;
  let subscriptionReady = false;

  const retryDelay = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 250));

  const connectUntilReady = async (
    topic: string,
    onMessage?: (message: string) => void,
  ): Promise<void> => {
    while (!closing) {
      try {
        // node-redis retries socket establishment internally. If connect or
        // initial subscribe rejects, retry without queuing publish commands.
        if (!client.isOpen) await client.connect();
        if (closing) return;
        if (client.isReady) {
          if (role === 'subscriber' && onMessage !== undefined) {
            await client.subscribe(topic, onMessage);
            subscriptionReady = true;
          }
          return;
        }
      } catch (error) {
        if (closing) return;
        reportError(error);
        if (client.isOpen && !client.isReady) client.destroy();
      }
      await retryDelay();
    }
  };

  return {
    isPublisherReady: () => role === 'publisher' && client.isReady,
    isSubscriberReady: () =>
      role === 'subscriber' && subscriptionReady && client.isReady,
    onError: (listener) => {
      errorListeners.add(listener);
    },
    start: (topic, onMessage) => {
      if (started || closing) return;
      if ((role === 'subscriber') !== (onMessage !== undefined)) {
        throw new Error('Redis public-event transport role does not match handler');
      }
      started = true;
      connectionRun = connectUntilReady(topic, onMessage);
    },
    publish: async (topic, message) => {
      if (role !== 'publisher') {
        throw new Error('Subscriber transport cannot publish');
      }
      await client.publish(topic, message);
    },
    close: async () => {
      if (closing) return;
      closing = true;
      subscriptionReady = false;
      if (client.isOpen) {
        if (client.isReady) {
          try {
            await client.close();
          } catch {
            client.destroy();
          }
        } else {
          client.destroy();
        }
      }
      if (connectionRun !== undefined) {
        await Promise.allSettled([connectionRun]);
      }
    },
  };
}

export function createNodeRedisIndexedEventPublisher(
  options: NodeRedisPublicEventOptions,
): IndexedEventPublisher {
  const url = options.url?.trim();
  if (!url) return createDisabledIndexedEventPublisher();
  const plane = new RedisPublicEventPlane({
    role: 'publisher',
    deployment: options.deployment,
    transport: createNodeRedisPublicEventTransport(url, 'publisher'),
  });
  plane.start();
  return plane;
}

export function createNodeRedisIndexedEventSubscriber(
  options: NodeRedisSubscriberOptions,
): IndexedEventSubscriber {
  const url = options.url?.trim();
  if (!url) return createDisabledIndexedEventSubscriber();
  if (options.onIndexedBatch === undefined) {
    throw new Error('Indexed-event subscriber requires a handler');
  }
  const plane = new RedisPublicEventPlane({
    role: 'subscriber',
    deployment: options.deployment,
    transport: createNodeRedisPublicEventTransport(url, 'subscriber'),
    onIndexedBatch: options.onIndexedBatch,
  });
  plane.start();
  return plane;
}
