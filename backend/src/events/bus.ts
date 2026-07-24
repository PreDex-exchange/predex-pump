import type { ServerEvent } from '@predex-pump/shared';

export interface PublishedServerEvent {
  event: ServerEvent;
  ts: number;
}

type EventListener = (published: PublishedServerEvent) => void;

export class ServerEventBus {
  readonly #listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(event: ServerEvent, ts: number): void {
    const published = { event, ts };
    for (const listener of this.#listeners) {
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
