import type { Channel, ServerEvent } from '@predex-pump/shared';

export interface PublishedServerEvent {
  event: ServerEvent;
  ts: number;
}

type EventListener = (published: PublishedServerEvent) => void;

export class ServerEventBus {
  readonly #listenersByChannel = new Map<Channel, Set<EventListener>>();

  hasSubscribers(channel: Channel): boolean {
    return (this.#listenersByChannel.get(channel)?.size ?? 0) > 0;
  }

  subscribedChannels(prefix: 'account:'): Channel[] {
    return [...this.#listenersByChannel.keys()].filter((channel) =>
      channel.startsWith(prefix),
    );
  }

  subscribe(channel: Channel, listener: EventListener): () => void {
    const listeners = this.#listenersByChannel.get(channel) ?? new Set<EventListener>();
    listeners.add(listener);
    this.#listenersByChannel.set(channel, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.#listenersByChannel.delete(channel);
      }
    };
  }

  publish(event: ServerEvent, ts: number): void {
    const published = { event, ts };
    const listeners = this.#listenersByChannel.get(event.channel);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      try {
        listener(published);
      } catch (error) {
        // A disconnected or malformed client must never interrupt indexing or
        // prevent delivery to the remaining subscribers.
        console.error('[ws] subscriber delivery failed', error);
      }
    }
  }
}
