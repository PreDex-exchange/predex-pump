import websocket from '@fastify/websocket';
import type {
  Channel,
  ServerMessage,
  WsInbound,
  WsOutbound,
} from '@predex-pump/shared';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

import type {
  PublishedServerEvent,
  ServerEventBus,
} from '../events/bus.js';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function normalizeChannel(value: unknown): Channel | null {
  if (value === 'markets' || value === 'activity') return value;
  if (typeof value !== 'string') return null;

  for (const prefix of ['market:', 'book:'] as const) {
    if (value.startsWith(prefix) && value.length > prefix.length) {
      return value as Channel;
    }
  }

  if (value.startsWith('account:')) {
    const account = value.slice('account:'.length);
    if (ADDRESS_PATTERN.test(account)) {
      return `account:${account.toLowerCase()}`;
    }
  }
  return null;
}

function parseInbound(raw: string): WsInbound {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Message must be valid JSON');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    (value.type !== 'subscribe' && value.type !== 'unsubscribe') ||
    !('channels' in value) ||
    !Array.isArray(value.channels) ||
    value.channels.length > 200
  ) {
    throw new Error('Expected a subscribe/unsubscribe message with channels');
  }
  const channels = value.channels.map(normalizeChannel);
  if (channels.some((channel) => channel === null)) {
    throw new Error('One or more channels are invalid');
  }
  return {
    type: value.type,
    channels: channels as Channel[],
  };
}

function send(socket: WebSocket, message: WsOutbound): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export async function registerWebsocketRoute(
  app: FastifyInstance,
  eventBus: ServerEventBus,
): Promise<void> {
  await app.register(websocket);

  app.get('/ws', { websocket: true }, (socket) => {
    const channels = new Set<Channel>();
    const unsubscribeByChannel = new Map<Channel, () => void>();
    const deliver = ({ event, ts }: PublishedServerEvent): void => {
      const message: ServerMessage = {
        type: 'update',
        channel: event.channel,
        event: event.event,
        data: event.data,
        ts,
      };
      send(socket, message);
    };

    socket.on('message', (raw) => {
      try {
        const message = parseInbound(raw.toString());
        for (const channel of message.channels) {
          if (message.type === 'subscribe') {
            if (!channels.has(channel)) {
              unsubscribeByChannel.set(
                channel,
                eventBus.subscribe(channel, deliver),
              );
            }
            channels.add(channel);
          } else {
            channels.delete(channel);
            unsubscribeByChannel.get(channel)?.();
            unsubscribeByChannel.delete(channel);
          }
        }
        send(socket, { type: 'ack', channels: [...channels] });
      } catch (error) {
        send(socket, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Invalid message',
        });
      }
    });

    const unsubscribeAll = (): void => {
      for (const unsubscribe of unsubscribeByChannel.values()) unsubscribe();
      unsubscribeByChannel.clear();
      channels.clear();
    };
    socket.once('close', unsubscribeAll);
    socket.once('error', unsubscribeAll);
  });
}
