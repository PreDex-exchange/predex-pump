import type {
  Channel,
  ServerMessage,
  SubscribeMessage,
} from '@predex-pump/shared/ws';
import WebSocket, { type RawData } from 'ws';

const DEFAULT_WS_URL = 'ws://localhost:3001/ws';

export type PredexWsListener = (message: ServerMessage) => void;
export type PredexWsErrorListener = (error: Error) => void;

export interface PredexWsClientOptions {
  url?: string;
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

export class PredexWsClient {
  readonly url: string;

  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly listeners = new Map<Channel, Set<PredexWsListener>>();
  private readonly errorListeners = new Set<PredexWsErrorListener>();

  constructor(options: PredexWsClientOptions = {}) {
    this.url = options.url?.trim() || DEFAULT_WS_URL;
  }

  connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('error', (error) => this.emitError(error));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
    });

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.off('error', onInitialError);
        this.connectPromise = null;
        this.send('subscribe', [...this.listeners.keys()]);
        resolve();
      };
      const onInitialError = (error: Error) => {
        socket.off('open', onOpen);
        this.connectPromise = null;
        reject(error);
      };
      socket.once('open', onOpen);
      socket.once('error', onInitialError);
    });
    return this.connectPromise;
  }

  async subscribe(channel: Channel, listener: PredexWsListener) {
    const alreadyConnected = this.socket?.readyState === WebSocket.OPEN;
    const channelListeners =
      this.listeners.get(channel) ?? new Set<PredexWsListener>();
    const firstListener = channelListeners.size === 0;
    channelListeners.add(listener);
    this.listeners.set(channel, channelListeners);

    await this.connect();
    if (firstListener && alreadyConnected) this.send('subscribe', [channel]);

    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size > 0) return;
      this.listeners.delete(channel);
      this.send('unsubscribe', [channel]);
    };
  }

  onError(listener: PredexWsErrorListener) {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    socket?.close(1000, 'Client closed');
  }

  private send(type: SubscribeMessage['type'], channels: Channel[]) {
    if (channels.length === 0 || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    const message: SubscribeMessage = { type, channels };
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(data: RawData) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString()) as unknown;
    } catch {
      return;
    }
    if (!isServerMessage(parsed)) return;
    for (const listener of this.listeners.get(parsed.channel) ?? []) {
      listener(parsed);
    }
  }

  private emitError(error: Error) {
    for (const listener of this.errorListeners) listener(error);
  }
}

export function createWsClient(options: PredexWsClientOptions = {}) {
  return new PredexWsClient(options);
}
