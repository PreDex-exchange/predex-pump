import {
  ADDRESSES,
  ARC,
  type PublicEventsHealth,
} from '@predex-pump/shared';

import type { ContractSource, DecodedEvent } from '../indexer/types.js';

export const PUBLIC_EVENT_SCHEMA_VERSION = 'v1' as const;
export const MAX_PUBLIC_EVENT_BYTES = 4 * 1024 * 1024;
export const MAX_INDEXED_EVENTS_PER_ENVELOPE = 1_000;
const MAX_TAGGED_VALUE_DEPTH = 32;
const REDIS_COMMAND_TIMEOUT_MS = 100;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/u;
const EVENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,127}$/u;
const CONTRACT_SOURCES = new Set<ContractSource>([
  'REGISTRY',
  'LMSR',
  'MINI_CLOB',
  'CTF',
  'CTF_EXCHANGE',
  'COLLATERAL',
  'ORACLE',
]);

export interface PublicEventDeployment {
  keyPrefix: string;
  chainId: number;
  registry: `0x${string}`;
}

export function predexPublicEventDeployment(
  keyPrefix: string,
): PublicEventDeployment {
  return {
    keyPrefix,
    chainId: ARC.chainId,
    registry: ADDRESSES.registry.toLowerCase() as `0x${string}`,
  };
}

interface WireNull {
  type: 'null';
}

interface WireScalar {
  type: 'string' | 'number' | 'boolean' | 'bigint';
  value: string | number | boolean;
}

interface WireArray {
  type: 'array';
  value: WireValue[];
}

interface WireObject {
  type: 'object';
  value: Array<[string, WireValue]>;
}

type WireValue = WireNull | WireScalar | WireArray | WireObject;

interface WireDecodedEvent {
  source: ContractSource;
  address: `0x${string}`;
  eventName: string;
  args: Array<[string, WireValue]>;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: number;
  ts: number;
}

export interface IndexedBatchEnvelope {
  schemaVersion: typeof PUBLIC_EVENT_SCHEMA_VERSION;
  deployment: PublicEventDeployment;
  kind: 'indexed.batch';
  events: DecodedEvent[];
}

interface WireIndexedBatchEnvelope
  extends Omit<IndexedBatchEnvelope, 'events'> {
  events: WireDecodedEvent[];
}

export interface PublicEventTransport {
  isPublisherReady(): boolean;
  isSubscriberReady(): boolean;
  onError(listener: (error: unknown) => void): void;
  start(topic: string, onMessage?: (message: string) => void): void;
  publish(topic: string, message: string): Promise<void>;
  close(): Promise<void>;
}

export interface PublicEventHealthReader {
  getHealth(): PublicEventsHealth;
}

interface PublicEventLifecycle extends PublicEventHealthReader {
  start(): void;
  close(): Promise<void>;
}

export interface IndexedEventPublisher extends PublicEventLifecycle {
  publishIndexedBatch(events: readonly DecodedEvent[]): Promise<void>;
}

export type IndexedEventSubscriber = PublicEventLifecycle;

export interface RedisPublicEventPlaneOptions {
  role: 'publisher' | 'subscriber';
  deployment: PublicEventDeployment;
  transport: PublicEventTransport;
  onIndexedBatch?: (events: readonly DecodedEvent[]) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key)
  );
}

function normalizeDeployment(
  deployment: PublicEventDeployment,
): PublicEventDeployment {
  const keyPrefix = deployment.keyPrefix.trim().replace(/:+$/u, '');
  if (!ID_PATTERN.test(keyPrefix)) {
    throw new Error('Public-event Redis key prefix is invalid');
  }
  if (!Number.isSafeInteger(deployment.chainId) || deployment.chainId <= 0) {
    throw new Error('Public-event chainId must be a positive safe integer');
  }
  if (!ADDRESS_PATTERN.test(deployment.registry)) {
    throw new Error('Public-event registry must be an EVM address');
  }
  return {
    keyPrefix,
    chainId: deployment.chainId,
    registry: deployment.registry.toLowerCase() as `0x${string}`,
  };
}

export function publicEventTopic(deployment: PublicEventDeployment): string {
  const normalized = normalizeDeployment(deployment);
  return (
    `${normalized.keyPrefix}:public-events:${PUBLIC_EVENT_SCHEMA_VERSION}:` +
    `${normalized.chainId}:${normalized.registry}`
  );
}

function deploymentMatches(
  received: unknown,
  expected: PublicEventDeployment,
): received is PublicEventDeployment {
  if (
    !isRecord(received) ||
    !hasExactKeys(received, ['keyPrefix', 'chainId', 'registry'])
  ) {
    return false;
  }
  return (
    received.keyPrefix === expected.keyPrefix &&
    received.chainId === expected.chainId &&
    typeof received.registry === 'string' &&
    received.registry.toLowerCase() === expected.registry
  );
}

function encodeValue(value: unknown, depth = 0): WireValue {
  if (depth > MAX_TAGGED_VALUE_DEPTH) {
    throw new Error('Decoded event value nesting is too deep');
  }
  if (value === null) return { type: 'null' };
  if (typeof value === 'bigint') {
    return { type: 'bigint', value: value.toString() };
  }
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Decoded event contains a non-finite number');
    }
    return { type: 'number', value };
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      value: value.map((entry) => encodeValue(entry, depth + 1)),
    };
  }
  if (isRecord(value)) {
    return {
      type: 'object',
      value: Object.entries(value).map(([key, entry]) => [
        key,
        encodeValue(entry, depth + 1),
      ]),
    };
  }
  throw new Error(`Decoded event contains unsupported ${typeof value} value`);
}

function decodeValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_TAGGED_VALUE_DEPTH) {
    throw new Error('Tagged event value nesting is too deep');
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Malformed tagged event value');
  }
  if (value.type === 'null' && hasExactKeys(value, ['type'])) return null;
  if (
    value.type === 'string' &&
    hasExactKeys(value, ['type', 'value']) &&
    typeof value.value === 'string'
  ) {
    return value.value;
  }
  if (
    value.type === 'boolean' &&
    hasExactKeys(value, ['type', 'value']) &&
    typeof value.value === 'boolean'
  ) {
    return value.value;
  }
  if (
    value.type === 'number' &&
    hasExactKeys(value, ['type', 'value']) &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value)
  ) {
    return value.value;
  }
  if (
    value.type === 'bigint' &&
    hasExactKeys(value, ['type', 'value']) &&
    typeof value.value === 'string' &&
    /^-?(0|[1-9][0-9]*)$/u.test(value.value)
  ) {
    return BigInt(value.value);
  }
  if (
    value.type === 'array' &&
    hasExactKeys(value, ['type', 'value']) &&
    Array.isArray(value.value)
  ) {
    return value.value.map((entry) => decodeValue(entry, depth + 1));
  }
  if (
    value.type === 'object' &&
    hasExactKeys(value, ['type', 'value']) &&
    Array.isArray(value.value)
  ) {
    const entries: Array<[string, unknown]> = [];
    const keys = new Set<string>();
    for (const entry of value.value) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        keys.has(entry[0])
      ) {
        throw new Error('Malformed tagged event object');
      }
      keys.add(entry[0]);
      entries.push([entry[0], decodeValue(entry[1], depth + 1)]);
    }
    return Object.fromEntries(entries);
  }
  throw new Error('Malformed tagged event value');
}

function encodeDecodedEvent(event: DecodedEvent): WireDecodedEvent {
  return {
    source: event.source,
    address: event.address,
    eventName: event.eventName,
    args: Object.entries(event.args).map(([key, value]) => [
      key,
      encodeValue(value),
    ]),
    txHash: event.txHash,
    logIndex: event.logIndex,
    blockNumber: event.blockNumber,
    ts: event.ts,
  };
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeDecodedEvent(value: unknown): DecodedEvent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'source',
      'address',
      'eventName',
      'args',
      'txHash',
      'logIndex',
      'blockNumber',
      'ts',
    ]) ||
    typeof value.source !== 'string' ||
    !CONTRACT_SOURCES.has(value.source as ContractSource) ||
    typeof value.address !== 'string' ||
    !ADDRESS_PATTERN.test(value.address) ||
    typeof value.eventName !== 'string' ||
    !EVENT_NAME_PATTERN.test(value.eventName) ||
    !Array.isArray(value.args) ||
    typeof value.txHash !== 'string' ||
    !HASH_PATTERN.test(value.txHash) ||
    !safeNonNegativeInteger(value.logIndex) ||
    !safeNonNegativeInteger(value.blockNumber) ||
    !safeNonNegativeInteger(value.ts)
  ) {
    throw new Error('Malformed indexed event');
  }
  const args = decodeValue({ type: 'object', value: value.args });
  if (!isRecord(args)) throw new Error('Malformed indexed event args');
  return {
    source: value.source as ContractSource,
    address: value.address as `0x${string}`,
    eventName: value.eventName,
    args,
    txHash: value.txHash as `0x${string}`,
    logIndex: value.logIndex,
    blockNumber: value.blockNumber,
    ts: value.ts,
  };
}

export function encodePublicEventEnvelope(
  envelope: IndexedBatchEnvelope,
): string {
  const deployment = normalizeDeployment(envelope.deployment);
  const wire: WireIndexedBatchEnvelope = {
    ...envelope,
    deployment,
    events: envelope.events.map(encodeDecodedEvent),
  };
  if (wire.events.length > MAX_INDEXED_EVENTS_PER_ENVELOPE) {
    throw new Error('Indexed public-event batch exceeds the event-count limit');
  }
  const serialized = JSON.stringify(wire);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PUBLIC_EVENT_BYTES) {
    throw new Error('Public-event envelope exceeds the byte limit');
  }
  return serialized;
}

export function decodePublicEventEnvelope(
  serialized: string,
  expectedDeployment: PublicEventDeployment,
): IndexedBatchEnvelope {
  const expected = normalizeDeployment(expectedDeployment);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PUBLIC_EVENT_BYTES) {
    throw new Error('Public-event envelope exceeds the byte limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error('Public-event envelope is not valid JSON');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'deployment', 'kind', 'events']) ||
    value.schemaVersion !== PUBLIC_EVENT_SCHEMA_VERSION ||
    !deploymentMatches(value.deployment, expected)
  ) {
    throw new Error('Public-event envelope has the wrong schema or deployment');
  }
  if (
    value.kind !== 'indexed.batch' ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_INDEXED_EVENTS_PER_ENVELOPE
  ) {
    throw new Error('Malformed public-event envelope');
  }
  return {
    schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
    deployment: expected,
    kind: 'indexed.batch',
    events: value.events.map(decodeDecodedEvent),
  };
}

function timeoutAfter(milliseconds: number): {
  promise: Promise<never>;
  cancel(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    promise: new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Redis publish timed out after ${milliseconds}ms`)),
        milliseconds,
      );
    }),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export class RedisPublicEventPlane implements IndexedEventPublisher {
  readonly #deployment: PublicEventDeployment;
  readonly #topic: string;
  readonly #health: PublicEventsHealth = {
    status: 'connecting',
    publisherReady: false,
    subscriberReady: false,
    published: 0,
    received: 0,
    rejected: 0,
    dropped: 0,
    errors: 0,
  };
  #started = false;
  #closing = false;
  #dispatchTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RedisPublicEventPlaneOptions) {
    this.#deployment = normalizeDeployment(options.deployment);
    this.#topic = publicEventTopic(this.#deployment);
    if (
      (options.role === 'subscriber') !==
      (options.onIndexedBatch !== undefined)
    ) {
      throw new Error('Subscriber role requires exactly one indexed-batch handler');
    }
    options.transport.onError(() => {
      if (!this.#closing) this.recordError();
    });
  }

  start(): void {
    if (this.#started || this.#closing) return;
    this.#started = true;
    try {
      this.options.transport.start(
        this.#topic,
        this.options.role === 'subscriber'
          ? (message) => this.enqueueMessage(message)
          : undefined,
      );
    } catch {
      this.recordError();
    }
  }

  getHealth(): PublicEventsHealth {
    const publisherReady =
      this.options.role === 'publisher' &&
      this.options.transport.isPublisherReady();
    const subscriberReady =
      this.options.role === 'subscriber' &&
      this.options.transport.isSubscriberReady();
    const ready = publisherReady || subscriberReady;
    return {
      ...this.#health,
      status: ready
        ? 'ready'
        : this.#health.errors > 0 || this.#health.dropped > 0
          ? 'degraded'
          : 'connecting',
      publisherReady,
      subscriberReady,
    };
  }

  async publishIndexedBatch(events: readonly DecodedEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (this.options.role !== 'publisher') {
      this.#health.dropped += 1;
      return;
    }
    for (
      let offset = 0;
      offset < events.length;
      offset += MAX_INDEXED_EVENTS_PER_ENVELOPE
    ) {
      await this.publishIndexedChunk(
        events.slice(offset, offset + MAX_INDEXED_EVENTS_PER_ENVELOPE),
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    await this.#dispatchTail.catch(() => undefined);
    await this.options.transport.close().catch(() => undefined);
  }

  private async publishIndexedChunk(
    events: readonly DecodedEvent[],
  ): Promise<void> {
    let serialized: string;
    try {
      serialized = encodePublicEventEnvelope({
        schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
        deployment: this.#deployment,
        kind: 'indexed.batch',
        events: [...events],
      });
    } catch {
      if (events.length > 1) {
        const midpoint = Math.ceil(events.length / 2);
        await this.publishIndexedChunk(events.slice(0, midpoint));
        await this.publishIndexedChunk(events.slice(midpoint));
        return;
      }
      this.recordError();
      this.#health.dropped += 1;
      return;
    }
    if (
      this.#closing ||
      !this.#started ||
      !this.options.transport.isPublisherReady()
    ) {
      this.#health.dropped += 1;
      return;
    }
    const timeout = timeoutAfter(REDIS_COMMAND_TIMEOUT_MS);
    try {
      await Promise.race([
        this.options.transport.publish(this.#topic, serialized),
        timeout.promise,
      ]);
      this.#health.published += 1;
    } catch {
      this.recordError();
      this.#health.dropped += 1;
    } finally {
      timeout.cancel();
    }
  }

  private enqueueMessage(serialized: string): void {
    if (this.#closing) return;
    this.#dispatchTail = this.#dispatchTail
      .then(async () => {
        let envelope: IndexedBatchEnvelope;
        try {
          envelope = decodePublicEventEnvelope(serialized, this.#deployment);
        } catch {
          this.#health.rejected += 1;
          return;
        }
        this.#health.received += 1;
        await this.options.onIndexedBatch?.(envelope.events);
      })
      .catch(() => {
        this.recordError();
      });
  }

  private recordError(): void {
    this.#health.errors += 1;
  }
}

const disabledHealth = (): PublicEventsHealth => ({
  status: 'disabled',
  publisherReady: false,
  subscriberReady: false,
  published: 0,
  received: 0,
  rejected: 0,
  dropped: 0,
  errors: 0,
});

export function createDisabledIndexedEventPublisher(): IndexedEventPublisher {
  return {
    start: () => undefined,
    publishIndexedBatch: async () => undefined,
    getHealth: disabledHealth,
    close: async () => undefined,
  };
}

export function createDisabledIndexedEventSubscriber(): IndexedEventSubscriber {
  return {
    start: () => undefined,
    getHealth: disabledHealth,
    close: async () => undefined,
  };
}
