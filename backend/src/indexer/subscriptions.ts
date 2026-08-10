import { ADDRESSES, ARC } from '@predex-pump/shared';
import {
  createPublicClient,
  defineChain,
  encodeEventTopics,
  type AbiEvent,
  type Address,
  type Hex,
  webSocket,
} from 'viem';

import {
  COLLATERAL_APPROVAL_EVENT,
  COLLATERAL_TRANSFER_EVENT,
  CORE_TRACKED_ADDRESSES,
  CTF_APPROVAL_EVENT,
  CTF_EVENT_ABI,
} from './abis.js';
import { toDbInt } from './derive.js';

const SUBSCRIPTION_REQUEST_TIMEOUT_MS = 10_000;

const arc = defineChain({
  id: ARC.chainId,
  name: ARC.name,
  nativeCurrency: ARC.nativeCurrency,
  rpcUrls: {
    default: {
      http: [...ARC.rpcUrls],
      webSocket: [...ARC.webSocketRpcUrls],
    },
  },
});

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
    chain: arc,
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

function logSubscriptionSpecs(
  collateralOwners: readonly Address[],
): SubscriptionSpec[] {
  const specs: SubscriptionSpec[] = [
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

  if (collateralOwners.length > 0) {
    specs.push(
      {
        label: 'collateral transfers in',
        parameters: [
          'logs',
          {
            address: ADDRESSES.usdc,
            topics: topicsForEvent(COLLATERAL_TRANSFER_EVENT, {
              to: [...collateralOwners],
            }),
          },
        ],
      },
      {
        label: 'collateral transfers out',
        parameters: [
          'logs',
          {
            address: ADDRESSES.usdc,
            topics: topicsForEvent(COLLATERAL_TRANSFER_EVENT, {
              from: [...collateralOwners],
            }),
          },
        ],
      },
    );
  }

  return specs;
}

function objectValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function hexBlockNumber(data: unknown, path: readonly string[]): number {
  let value = data;
  for (const key of path) value = objectValue(value, key);
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error('WebSocket subscription payload omitted a block number');
  }
  return toDbInt(BigInt(value), 'subscription.blockNumber');
}

function headBlockNumber(data: unknown): number {
  return hexBlockNumber(data, ['result', 'number']);
}

function logBlockNumber(data: unknown): number {
  return hexBlockNumber(data, ['result', 'blockNumber']);
}

function errorFrom(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'object' && value !== null) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string') return new Error(message);
  }
  return new Error(String(value));
}

function ownerFingerprint(owners: readonly Address[]): string {
  return [...new Set(owners.map((owner) => owner.toLowerCase()))]
    .sort()
    .join(',');
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
  ownerRefreshMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  loadCollateralOwners: () => Promise<readonly Address[]>;
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
  onHead: (blockNumber: number) => void;
  onActivity: (blockNumber: number, generation: number) => void;
  onHeartbeat: (details: {
    blockNumber: number;
    generation: number;
    receivedAt: Date;
  }) => Promise<void>;
  onOwnerFilterRefresh: (ownerCount: number) => void;
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
    let refreshOwners = false;

    const failSession = (error: unknown): void => {
      if (!active || sessionError !== undefined) return;
      sessionError = errorFrom(error);
      sessionWake.notify();
    };

    try {
      await options.onConnecting(url);
      const collateralOwners = await options.loadCollateralOwners();
      let ownersFingerprint = ownerFingerprint(collateralOwners);
      const specs = logSubscriptionSpecs(collateralOwners);
      transport = options.createTransport(url);

      let latestHead: number | undefined;
      let lastHeadAt = options.now().getTime();
      let lastHeartbeatAt = lastHeadAt;
      let nextOwnerRefreshAt = lastHeadAt + options.ownerRefreshMs;

      try {
        handles.push(
          await transport.subscribe(
            ['newHeads'],
            {
              onData(data) {
                try {
                  if (!active) return;
                  const firstHead = latestHead === undefined;
                  latestHead = Math.max(latestHead ?? 0, headBlockNumber(data));
                  lastHeadAt = options.now().getTime();
                  options.onHead(latestHead);
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
                    options.onActivity(
                      logBlockNumber(data),
                      connectedGeneration,
                    );
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
        const wakeAt = Math.min(
          nextHeartbeatAt,
          nextStallCheckAt,
          nextOwnerRefreshAt,
        );
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

        if (afterWait >= nextOwnerRefreshAt) {
          const nextOwners = await options.loadCollateralOwners();
          const nextFingerprint = ownerFingerprint(nextOwners);
          nextOwnerRefreshAt = afterWait + options.ownerRefreshMs;
          if (nextFingerprint !== ownersFingerprint) {
            ownersFingerprint = nextFingerprint;
            refreshOwners = true;
            options.onOwnerFilterRefresh(nextOwners.length);
            break;
          }
        }
      }

      if (options.signal.aborted) break;
      if (refreshOwners) {
        failureCount = 0;
      } else if (sessionError === undefined) {
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

    const retryInMs = refreshOwners
      ? 0
      : Math.min(
          options.reconnectMaxMs,
          options.reconnectBaseMs * 2 ** Math.min(failureCount, 20),
        );
    if (!refreshOwners) {
      failureCount += 1;
      urlIndex = (urlIndex + 1) % options.urls.length;
    }
    await options.onDisconnected({
      generation: connectedGeneration,
      error:
        sessionError ?? new Error('Refreshing dynamic collateral-owner filters'),
      retryInMs,
    });
    if (retryInMs > 0) {
      await options.wait(retryInMs, options.signal);
    }
  }
}

export function subscriptionEndpointLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'configured-endpoint';
  }
}
