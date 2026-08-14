import { ADDRESSES } from '@predex-pump/shared';
import {
  createPublicClient,
  encodeEventTopics,
  type AbiEvent,
  type Address,
  type Hex,
  webSocket,
} from 'viem';

import { ARC_CHAIN } from '../chain.js';
import {
  COLLATERAL_APPROVAL_EVENT,
  CORE_TRACKED_ADDRESSES,
  CTF_APPROVAL_EVENT,
  CTF_EVENT_ABI,
} from './abis.js';
import { toDbInt } from './derive.js';

const SUBSCRIPTION_REQUEST_TIMEOUT_MS = 10_000;

type SubscriptionTopic = Hex | Hex[] | null;

export type IndexerSubscriptionParameters =
  | ['newHeads']
  | [
      'logs',
      {
        address?: Address | Address[];
        topics?: SubscriptionTopic[];
      },
    ];

export interface IndexerSubscriptionHandle {
  unsubscribe: () => void;
}

export interface IndexerSubscriptionTransport {
  subscribe: (
    parameters: IndexerSubscriptionParameters,
    handlers: {
      onData: (data: unknown) => void;
      onError: (error: unknown) => void;
    },
    signal: AbortSignal,
  ) => Promise<IndexerSubscriptionHandle>;
  close: () => Promise<void>;
}

export type IndexerSubscriptionTransportFactory = (
  url: string,
) => IndexerSubscriptionTransport;

export function createViemSubscriptionTransport(
  url: string,
): IndexerSubscriptionTransport {
  const client = createPublicClient({
    chain: ARC_CHAIN,
    transport: webSocket(url, {
      keepAlive: { interval: 10_000 },
      reconnect: false,
      retryCount: 0,
      timeout: 10_000,
    }),
  });
  let rpcClientPromise:
    | ReturnType<typeof client.transport.getRpcClient>
    | undefined;
  let rpcClient:
    | Awaited<ReturnType<typeof client.transport.getRpcClient>>
    | undefined;

  const getRpcClient = () => {
    rpcClientPromise ??= client.transport.getRpcClient().then((client_) => {
      rpcClient = client_;
      return client_;
    });
    return rpcClientPromise;
  };

  return {
    async subscribe(parameters, handlers, signal) {
      const pending = (async (): Promise<IndexerSubscriptionHandle> => {
        await getRpcClient();
        const request = {
          params: parameters,
          onData: handlers.onData,
          onError: handlers.onError,
        } as Parameters<typeof client.transport.subscribe>[0];
        const subscription = await client.transport.subscribe(request);
        return {
          unsubscribe() {
            void subscription.unsubscribe().catch(() => undefined);
          },
        };
      })();
      return await subscriptionRequestWithDeadline(pending, signal);
    },
    async close() {
      if (rpcClientPromise === undefined) return;
      if (rpcClient !== undefined) {
        rpcClient.close();
        return;
      }
      void rpcClientPromise.then((client_) => client_.close()).catch(() => undefined);
    },
  };
}

function subscriptionRequestWithDeadline(
  pending: Promise<IndexerSubscriptionHandle>,
  signal: AbortSignal,
): Promise<IndexerSubscriptionHandle> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new Error(
          `eth_subscribe timed out after ${SUBSCRIPTION_REQUEST_TIMEOUT_MS}ms`,
        ),
      );
    }, SUBSCRIPTION_REQUEST_TIMEOUT_MS);
    const abort = () => finish(new Error('WebSocket subscription aborted'));

    function finish(
      error: Error | undefined,
      handle?: IndexerSubscriptionHandle,
    ): void {
      if (settled) {
        handle?.unsubscribe();
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error === undefined && handle !== undefined) resolve(handle);
      else reject(error ?? new Error('WebSocket subscription failed'));
    }

    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(
      (handle) => finish(undefined, handle),
      (error: unknown) => finish(errorFrom(error)),
    );
  });
}

interface SubscriptionSpec {
  label: string;
  parameters: IndexerSubscriptionParameters;
}

function topicsForEvent(
  event: AbiEvent,
  args?: Record<string, unknown>,
): SubscriptionTopic[] {
  const parameters = {
    abi: [event],
    eventName: event.name,
    ...(args === undefined ? {} : { args }),
  } as Parameters<typeof encodeEventTopics>[0];
  return encodeEventTopics(parameters) as SubscriptionTopic[];
}

function eventSelector(event: AbiEvent): Hex {
  const selector = topicsForEvent(event)[0];
  if (typeof selector !== 'string') {
    throw new Error(`Unable to encode event selector for ${event.name}`);
  }
  return selector;
}

function logSubscriptionSpecs(): SubscriptionSpec[] {
  return [
    {
      label: 'core contracts',
      parameters: [
        'logs',
        { address: [...CORE_TRACKED_ADDRESSES] },
      ],
    },
    {
      label: 'CTF events',
      parameters: [
        'logs',
        {
          address: ADDRESSES.ctf,
          topics: [CTF_EVENT_ABI.map(eventSelector)],
        },
      ],
    },
    {
      label: 'CTF exchange approvals',
      parameters: [
        'logs',
        {
          address: ADDRESSES.ctf,
          topics: topicsForEvent(CTF_APPROVAL_EVENT, {
            operator: ADDRESSES.ctfExchange,
          }),
        },
      ],
    },
    {
      label: 'collateral exchange approvals',
      parameters: [
        'logs',
        {
          address: ADDRESSES.usdc,
          topics: topicsForEvent(COLLATERAL_APPROVAL_EVENT, {
            spender: ADDRESSES.ctfExchange,
          }),
        },
      ],
    },
  ];
}

function objectValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function hexQuantity(
  data: unknown,
  path: readonly string[],
  label: string,
): number {
  let value = data;
  for (const key of path) value = objectValue(value, key);
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`WebSocket subscription payload omitted ${label}`);
  }
  return toDbInt(BigInt(value), `subscription.${label}`);
}

function requiredHex(
  value: unknown,
  label: string,
  byteLength?: number,
): Hex {
  const lengthPattern =
    byteLength === undefined ? '[0-9a-f]*' : `[0-9a-f]{${String(byteLength * 2)}}`;
  if (
    typeof value !== 'string' ||
    !new RegExp(`^0x${lengthPattern}$`, 'i').test(value)
  ) {
    throw new Error(`WebSocket subscription payload omitted ${label}`);
  }
  return value as Hex;
}

export interface IndexerSubscriptionHead {
  blockNumber: number;
  timestamp: number;
}

export interface IndexerSubscriptionLog {
  address: Address;
  blockHash: Hex;
  blockNumber: number;
  data: Hex;
  logIndex: number;
  removed: boolean;
  topics: readonly Hex[];
  transactionHash: Hex;
  transactionIndex: number;
}

function subscriptionHead(data: unknown): IndexerSubscriptionHead {
  return {
    blockNumber: hexQuantity(data, ['result', 'number'], 'blockNumber'),
    timestamp: hexQuantity(data, ['result', 'timestamp'], 'blockTimestamp'),
  };
}

function subscriptionLog(data: unknown): IndexerSubscriptionLog {
  const result = objectValue(data, 'result');
  const address = requiredHex(objectValue(result, 'address'), 'log.address', 20);
  const topicsValue = objectValue(result, 'topics');
  if (!Array.isArray(topicsValue) || topicsValue.length === 0) {
    throw new Error('WebSocket subscription payload omitted log.topics');
  }
  const removed = objectValue(result, 'removed');
  if (typeof removed !== 'boolean') {
    throw new Error('WebSocket subscription payload omitted log.removed');
  }

  return {
    address: address as Address,
    blockHash: requiredHex(
      objectValue(result, 'blockHash'),
      'log.blockHash',
      32,
    ),
    blockNumber: hexQuantity(data, ['result', 'blockNumber'], 'blockNumber'),
    data: requiredHex(objectValue(result, 'data'), 'log.data'),
    logIndex: hexQuantity(data, ['result', 'logIndex'], 'logIndex'),
    removed,
    topics: topicsValue.map((topic, index) =>
      requiredHex(topic, `log.topics[${String(index)}]`, 32),
    ),
    transactionHash: requiredHex(
      objectValue(result, 'transactionHash'),
      'log.transactionHash',
      32,
    ),
    transactionIndex: hexQuantity(
      data,
      ['result', 'transactionIndex'],
      'transactionIndex',
    ),
  };
}

export function subscriptionLogId(
  log: Pick<IndexerSubscriptionLog, 'transactionHash' | 'logIndex'>,
): string {
  return `${log.transactionHash.toLowerCase()}:${String(log.logIndex)}`;
}

function errorFrom(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'object' && value !== null) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string') return new Error(message);
  }
  return new Error(String(value));
}

class WakeSignal {
  private pending = false;
  private wake: (() => void) | undefined;

  notify(): void {
    this.pending = true;
    this.wake?.();
  }

  async wait(
    milliseconds: number,
    signal: AbortSignal,
    wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.pending || signal.aborted) {
      this.pending = false;
      return;
    }

    const timerController = new AbortController();
    const abortTimer = () => timerController.abort();
    signal.addEventListener('abort', abortTimer, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          this.wake = undefined;
          timerController.abort();
          if (error === undefined) resolve();
          else reject(error);
        };
        this.wake = () => finish();
        void wait(milliseconds, timerController.signal).then(
          () => finish(),
          (error) => finish(error),
        );
      });
    } finally {
      this.pending = false;
      signal.removeEventListener('abort', abortTimer);
    }
  }
}

export interface SubscriptionSupervisorOptions {
  urls: readonly string[];
  signal: AbortSignal;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now: () => Date;
  stallMs: number;
  heartbeatMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  createTransport: IndexerSubscriptionTransportFactory;
  onConnecting: (url: string) => Promise<void>;
  onConnected: (details: {
    generation: number;
    url: string;
    logSubscriptionCount: number;
  }) => Promise<void>;
  onDisconnected: (details: {
    generation: number | undefined;
    error: Error;
    retryInMs: number;
  }) => Promise<void>;
  onInvalidated: (details: {
    generation: number | undefined;
    error: Error;
  }) => void;
  onHead: (
    head: IndexerSubscriptionHead & { generation: number },
  ) => void;
  onLog: (log: IndexerSubscriptionLog, generation: number) => void;
  onHeartbeat: (details: {
    blockNumber: number;
    generation: number;
    receivedAt: Date;
  }) => Promise<void>;
}

export async function runSubscriptionSupervisor(
  options: SubscriptionSupervisorOptions,
): Promise<void> {
  if (options.urls.length === 0) return;

  let failureCount = 0;
  let generation = 0;
  let urlIndex = 0;

  while (!options.signal.aborted) {
    const url = options.urls[urlIndex % options.urls.length];
    if (url === undefined) return;
    let transport: IndexerSubscriptionTransport | undefined;
    const handles: IndexerSubscriptionHandle[] = [];
    const sessionWake = new WakeSignal();
    let active = true;
    let sessionError: Error | undefined;
    let connectedGeneration: number | undefined;

    const failSession = (error: unknown): void => {
      if (!active || sessionError !== undefined) return;
      sessionError = errorFrom(error);
      options.onInvalidated({
        generation: connectedGeneration,
        error: sessionError,
      });
      sessionWake.notify();
    };

    try {
      await options.onConnecting(url);
      const specs = logSubscriptionSpecs();
      transport = options.createTransport(url);

      let latestHead: number | undefined;
      let lastHeadAt = options.now().getTime();
      let lastHeartbeatAt = lastHeadAt;

      try {
        handles.push(
          await transport.subscribe(
            ['newHeads'],
            {
              onData(data) {
                try {
                  if (!active) return;
                  const head = subscriptionHead(data);
                  const firstHead = latestHead === undefined;
                  latestHead = Math.max(latestHead ?? 0, head.blockNumber);
                  lastHeadAt = options.now().getTime();
                  if (connectedGeneration !== undefined) {
                    options.onHead({ ...head, generation: connectedGeneration });
                  }
                  failureCount = 0;
                  if (
                    firstHead ||
                    lastHeadAt - lastHeartbeatAt >= options.heartbeatMs
                  ) {
                    sessionWake.notify();
                  }
                } catch (error) {
                  failSession(error);
                }
              },
              onError: failSession,
            },
            options.signal,
          ),
        );
      } catch (error) {
        sessionError = new Error(
          `eth_subscribe newHeads failed: ${errorFrom(error).message}`,
        );
        throw sessionError;
      }

      for (const spec of specs) {
        try {
          handles.push(
            await transport.subscribe(
              spec.parameters,
              {
                onData(data) {
                  try {
                    if (!active || connectedGeneration === undefined) return;
                    const log = subscriptionLog(data);
                    options.onLog(log, connectedGeneration);
                    if (log.removed) {
                      // Arc exposes finalized blocks, so removal contradicts
                      // this session's authority. The runner tombstones the
                      // buffered add above; then the supervisor forces a fresh
                      // canonical gap-fill instead of treating removal as data.
                      failSession(
                        new Error(
                          `subscription removed canonical log ${subscriptionLogId(log)} ` +
                            `at block ${String(log.blockNumber)}`,
                        ),
                      );
                    }
                  } catch (error) {
                    failSession(error);
                  }
                },
                onError: failSession,
              },
              options.signal,
            ),
          );
        } catch (error) {
          sessionError = new Error(
            `eth_subscribe ${spec.label} failed: ${errorFrom(error).message}`,
          );
          throw sessionError;
        }
      }

      if (sessionError !== undefined) throw sessionError;

      generation += 1;
      connectedGeneration = generation;
      await options.onConnected({
        generation,
        url,
        logSubscriptionCount: specs.length,
      });

      while (!options.signal.aborted && sessionError === undefined) {
        const currentTime = options.now().getTime();
        const nextHeartbeatAt =
          latestHead === undefined
            ? Number.POSITIVE_INFINITY
            : lastHeartbeatAt + options.heartbeatMs;
        const nextStallCheckAt = lastHeadAt + options.stallMs;
        const wakeAt = Math.min(nextHeartbeatAt, nextStallCheckAt);
        await sessionWake.wait(
          Math.max(1, wakeAt - currentTime),
          options.signal,
          options.wait,
        );
        if (options.signal.aborted || sessionError !== undefined) break;

        const afterWait = options.now().getTime();
        if (afterWait - lastHeadAt >= options.stallMs) {
          failSession(
            new Error(
              `newHeads subscription was silent for ${String(afterWait - lastHeadAt)}ms`,
            ),
          );
          break;
        }

        if (
          latestHead !== undefined &&
          afterWait - lastHeartbeatAt >= options.heartbeatMs
        ) {
          await options.onHeartbeat({
            blockNumber: latestHead,
            generation,
            receivedAt: new Date(lastHeadAt),
          });
          lastHeartbeatAt = afterWait;
        }
      }

      if (options.signal.aborted) break;
      if (sessionError === undefined) {
        sessionError = new Error('WebSocket subscription session ended');
      }
    } catch (error) {
      sessionError ??= errorFrom(error);
    } finally {
      active = false;
      for (const handle of handles) handle.unsubscribe();
      await transport?.close().catch(() => undefined);
    }

    if (options.signal.aborted) break;

    const retryInMs = Math.min(
      options.reconnectMaxMs,
      options.reconnectBaseMs * 2 ** Math.min(failureCount, 20),
    );
    failureCount += 1;
    urlIndex = (urlIndex + 1) % options.urls.length;
    await options.onDisconnected({
      generation: connectedGeneration,
      error: sessionError ?? new Error('WebSocket subscription session ended'),
      retryInMs,
    });
    await options.wait(retryInMs, options.signal);
  }
}

export function subscriptionEndpointLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'configured-endpoint';
  }
}
