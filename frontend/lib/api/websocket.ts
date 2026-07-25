import type {
  Channel,
  ServerMessage,
  SubscribeMessage,
} from '@predex-pump/shared/ws';

const DEFAULT_WS_URL = 'ws://localhost:3001/ws';
const MAX_RECONNECT_DELAY_MS = 15_000;
const MOCK_DATA_ENABLED =
  process.env.NEXT_PUBLIC_USE_MOCK_DATA === 'true';

export type BackendEventListener = (message: ServerMessage) => void;

function publicUrl(value: string | undefined, fallback: string) {
  return value?.trim() || fallback;
}

function isServerMessage(value: unknown): value is ServerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'update' &&
    'channel' in value &&
    typeof value.channel === 'string' &&
    'event' in value &&
    typeof value.event === 'string' &&
    'ts' in value &&
    typeof value.ts === 'number' &&
    'data' in value
  );
}

export const backendWsUrl = publicUrl(
  process.env.NEXT_PUBLIC_WS_URL,
  DEFAULT_WS_URL,
);

class BackendWebSocketClient {
  private socket: WebSocket | null = null;
  private readonly listeners = new Map<Channel, Set<BackendEventListener>>();
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;

  subscribe(channel: Channel, listener: BackendEventListener) {
    if (MOCK_DATA_ENABLED) return () => undefined;

    const channelListeners =
      this.listeners.get(channel) ?? new Set<BackendEventListener>();
    const firstListener = channelListeners.size === 0;
    channelListeners.add(listener);
    this.listeners.set(channel, channelListeners);

    if (firstListener && this.socket?.readyState === WebSocket.OPEN) {
      this.send('subscribe', [channel]);
    } else {
      this.connect();
    }

    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size > 0) return;

      this.listeners.delete(channel);
      this.send('unsubscribe', [channel]);
      this.closeIfIdle();
    };
  }

  private connect() {
    if (
      typeof window === 'undefined' ||
      typeof WebSocket === 'undefined' ||
      this.listeners.size === 0 ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(backendWsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.send('subscribe', [...this.listeners.keys()]);
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      if (!isServerMessage(parsed)) return;

      for (const listener of this.listeners.get(parsed.channel) ?? []) {
        listener(parsed);
      }
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (this.socket === socket) socket.close();
    });
  }

  private send(type: SubscribeMessage['type'], channels: Channel[]) {
    if (channels.length === 0 || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    const message: SubscribeMessage = { type, channels };
    this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect() {
    if (
      typeof window === 'undefined' ||
      this.listeners.size === 0 ||
      this.reconnectTimer !== null
    ) {
      return;
    }
    const delay = Math.min(
      1_000 * 2 ** this.reconnectAttempt,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private closeIfIdle() {
    if (this.listeners.size > 0) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'No active subscriptions');
  }
}

export const backendWsClient = new BackendWebSocketClient();
