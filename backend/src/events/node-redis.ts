import { createClient } from '@redis/client';

import {
  createDisabledPublicEventPlane,
  RedisPublicEventPlane,
  type PublicEventDeployment,
  type PublicEventHandlers,
  type PublicEventPlane,
  type PublicEventTransport,
} from './public-plane.js';

export interface NodeRedisPublicEventPlaneOptions {
  url: string | undefined;
  deployment: PublicEventDeployment;
  handlers?: PublicEventHandlers;
  producerId?: string;
}

export function createNodeRedisPublicEventTransport(
  url: string,
): PublicEventTransport {
  // Pub/Sub mode occupies a connection, so commands and subscriptions must
  // never share a client. Offline queues are disabled to avoid replaying stale
  // notifications after Redis recovers.
  const publisher = createClient({ url, disableOfflineQueue: true });
  const subscriber = createClient({ url, disableOfflineQueue: true });
  const errorListeners = new Set<(error: unknown) => void>();
  const reportError = (error: unknown): void => {
    for (const listener of errorListeners) listener(error);
  };
  publisher.on('error', reportError);
  subscriber.on('error', reportError);
  let started = false;
  let closing = false;
  let subscriberEnabled = false;
  let publisherRun: Promise<void> | undefined;
  let subscriberRun: Promise<void> | undefined;

  const retryDelay = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 250));

  const connectUntilReady = async (
    client: typeof publisher,
    afterConnect?: () => Promise<void>,
  ): Promise<void> => {
    while (!closing) {
      try {
        // node-redis retries socket establishment internally. If connect or
        // the initial subscribe still rejects, this outer loop establishes a
        // new attempt without queueing any publish command.
        if (!client.isOpen) await client.connect();
        if (closing) return;
        if (client.isReady) {
          await afterConnect?.();
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

  const closeClient = async (client: typeof publisher): Promise<void> => {
    if (!client.isOpen) return;
    if (!client.isReady) {
      client.destroy();
      return;
    }
    try {
      await client.close();
    } catch {
      client.destroy();
    }
  };

  return {
    isPublisherReady: () => publisher.isReady,
    isSubscriberReady: () => subscriberEnabled && subscriber.isReady,
    onError: (listener) => {
      errorListeners.add(listener);
    },
    start: (topic, onMessage) => {
      if (started || closing) return;
      started = true;
      publisherRun = connectUntilReady(publisher);
      if (onMessage !== undefined) {
        subscriberEnabled = true;
        subscriberRun = connectUntilReady(subscriber, async () => {
          await subscriber.subscribe(topic, onMessage);
        });
      }
    },
    publish: async (topic, message) => {
      await publisher.publish(topic, message);
    },
    close: async () => {
      if (closing) return;
      closing = true;
      await Promise.all([closeClient(subscriber), closeClient(publisher)]);
      await Promise.allSettled(
        [publisherRun, subscriberRun].filter(
          (run): run is Promise<void> => run !== undefined,
        ),
      );
    },
  };
}

/** Creates and starts a non-blocking Redis event plane, or a no-op when absent. */
export function createNodeRedisPublicEventPlane(
  options: NodeRedisPublicEventPlaneOptions,
): PublicEventPlane {
  const url = options.url?.trim();
  if (!url) return createDisabledPublicEventPlane();
  const plane = new RedisPublicEventPlane({
    deployment: options.deployment,
    transport: createNodeRedisPublicEventTransport(url),
    ...(options.handlers === undefined ? {} : { handlers: options.handlers }),
    ...(options.producerId === undefined ? {} : { producerId: options.producerId }),
  });
  plane.start();
  return plane;
}
