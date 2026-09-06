import { randomUUID } from 'node:crypto';

import {
  ADDRESSES,
  ARC,
  type PublicEventsHealth,
  type ServerEvent,
} from '@predex-pump/shared';

import type { DecodedEvent, ContractSource } from '../indexer/types.js';

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

interface EnvelopeBase {
  schemaVersion: typeof PUBLIC_EVENT_SCHEMA_VERSION;
  deployment: PublicEventDeployment;
  producerId: string;
  messageId: string;
}

export interface IndexedBatchEnvelope extends EnvelopeBase {
  kind: 'indexed.batch';
  events: DecodedEvent[];
}

export interface ServerEventEnvelope extends EnvelopeBase {
  kind: 'server.event';
  event: ServerEvent;
  ts: number;
}

export type PublicEventEnvelope = IndexedBatchEnvelope | ServerEventEnvelope;

interface WireIndexedBatchEnvelope extends EnvelopeBase {
  kind: 'indexed.batch';
  events: WireDecodedEvent[];
}

type WirePublicEventEnvelope = WireIndexedBatchEnvelope | ServerEventEnvelope;

export interface PublicEventHandlers {
  onIndexedBatch(events: readonly DecodedEvent[]): Promise<void>;
  onServerEvent(event: ServerEvent, ts: number): Promise<void> | void;
}

/** Narrow transport seam keeps Redis lifecycle separate from codec/fan-out policy. */
export interface PublicEventTransport {
  isPublisherReady(): boolean;
  isSubscriberReady(): boolean;
  onError(listener: (error: unknown) => void): void;
  start(topic: string, onMessage?: (message: string) => void): void;
  publish(topic: string, message: string): Promise<void>;
  close(): Promise<void>;
}

export interface PublicEventPublisher {
  publishIndexedBatch(events: readonly DecodedEvent[]): Promise<void>;
  publishServerEvent(event: ServerEvent, ts: number): Promise<void>;
}

export interface PublicEventPlane extends PublicEventPublisher {
  start(): void;
  getHealth(): PublicEventsHealth;
  close(): Promise<void>;
}

export interface RedisPublicEventPlaneOptions {
  deployment: PublicEventDeployment;
  transport: PublicEventTransport;
  handlers?: PublicEventHandlers;
  producerId?: string;
  createMessageId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key)
  );
}

function normalizeDeployment(deployment: PublicEventDeployment): PublicEventDeployment {
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
  if (!isRecord(received) || !hasExactKeys(received, ['keyPrefix', 'chainId', 'registry'])) {
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
  if (typeof value === 'string' || typeof value === 'boolean') {
    return { type: value, value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Decoded event contains a non-finite number');
    }
    return { type: 'number', value };
  }
  if (Array.isArray(value)) {
    return { type: 'array', value: value.map((entry) => encodeValue(entry, depth + 1)) };
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
    args: Object.entries(event.args).map(([key, value]) => [key, encodeValue(value)]),
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

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => isJsonValue(entry, depth + 1))
  );
}

function validServerEventPair(channel: string, event: string): boolean {
  if (channel === 'markets') {
    return ['market.created', 'market.updated', 'market.graduated'].includes(event);
  }
  if (channel === 'activity') return event === 'activity';
  if (/^market:[0-9]+$/u.test(channel)) {
    return ['price.tick', 'trade', 'graduated', 'resolution'].includes(event);
  }
  if (/^book:[0-9]+$/u.test(channel)) {
    return [
      'order.placed',
      'order.filled',
      'order.cancelled',
      'book.seeded',
      'offchain.order.placed',
      'offchain.order.withdrawn',
      'book.updated',
    ].includes(event);
  }
  if (/^account:0x[0-9a-fA-F]{40}$/u.test(channel)) {
    return event === 'position.updated' || event === 'trade';
  }
  return false;
}

function decodeServerEvent(value: unknown): ServerEvent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['channel', 'event', 'data']) ||
    typeof value.channel !== 'string' ||
    typeof value.event !== 'string' ||
    !validServerEventPair(value.channel, value.event) ||
    !isRecord(value.data) ||
    !isJsonValue(value.data)
  ) {
    throw new Error('Malformed server event');
  }
  return value as unknown as ServerEvent;
}

function validEnvelopeBase(
  value: Record<string, unknown>,
  expected: PublicEventDeployment,
): boolean {
  return (
    value.schemaVersion === PUBLIC_EVENT_SCHEMA_VERSION &&
    deploymentMatches(value.deployment, expected) &&
    typeof value.producerId === 'string' &&
    ID_PATTERN.test(value.producerId) &&
    typeof value.messageId === 'string' &&
    ID_PATTERN.test(value.messageId)
  );
}

export function encodePublicEventEnvelope(envelope: PublicEventEnvelope): string {
  const deployment = normalizeDeployment(envelope.deployment);
  if (!ID_PATTERN.test(envelope.producerId) || !ID_PATTERN.test(envelope.messageId)) {
    throw new Error('Public-event producerId and messageId must be bounded identifiers');
  }
  const wire: WirePublicEventEnvelope =
    envelope.kind === 'indexed.batch'
      ? {
          ...envelope,
          deployment,
          events: envelope.events.map(encodeDecodedEvent),
        }
      : { ...envelope, deployment };
  if (
    wire.kind === 'indexed.batch' &&
    wire.events.length > MAX_INDEXED_EVENTS_PER_ENVELOPE
  ) {
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
): PublicEventEnvelope {
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
  if (!isRecord(value) || !validEnvelopeBase(value, expected)) {
    throw new Error('Public-event envelope has the wrong schema or deployment');
  }
  if (
    value.kind === 'indexed.batch' &&
    hasExactKeys(value, [
      'schemaVersion',
      'deployment',
      'producerId',
      'messageId',
      'kind',
      'events',
    ]) &&
    Array.isArray(value.events) &&
    value.events.length <= MAX_INDEXED_EVENTS_PER_ENVELOPE
  ) {
    return {
      schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
      deployment: expected,
      producerId: value.producerId as string,
      messageId: value.messageId as string,
      kind: 'indexed.batch',
      events: value.events.map(decodeDecodedEvent),
    };
  }
  if (
    value.kind === 'server.event' &&
    hasExactKeys(value, [
      'schemaVersion',
      'deployment',
      'producerId',
      'messageId',
      'kind',
      'event',
      'ts',
    ]) &&
    safeNonNegativeInteger(value.ts)
  ) {
    return {
      schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
      deployment: expected,
      producerId: value.producerId as string,
      messageId: value.messageId as string,
      kind: 'server.event',
      event: decodeServerEvent(value.event),
      ts: value.ts,
    };
  }
  throw new Error('Malformed public-event envelope');
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

export class RedisPublicEventPlane implements PublicEventPlane {
  readonly #deployment: PublicEventDeployment;
  readonly #topic: string;
  readonly #producerId: string;
  readonly #createMessageId: () => string;
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
    this.#producerId = options.producerId ?? randomUUID();
    this.#createMessageId = options.createMessageId ?? randomUUID;
    if (!ID_PATTERN.test(this.#producerId)) {
      throw new Error('Public-event producerId must be a bounded identifier');
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
        this.options.handlers === undefined
          ? undefined
          : (message) => this.enqueueMessage(message),
      );
    } catch {
      this.recordError();
    }
  }

  getHealth(): PublicEventsHealth {
    const publisherReady = this.options.transport.isPublisherReady();
    const subscriberReady =
      this.options.handlers === undefined || this.options.transport.isSubscriberReady();
    const ready = publisherReady && subscriberReady;
    return {
      ...this.#health,
      status: ready
        ? 'ready'
        : this.#health.errors > 0 || this.#health.dropped > 0
          ? 'degraded'
          : 'connecting',
      publisherReady,
      subscriberReady:
        this.options.handlers === undefined
          ? false
          : this.options.transport.isSubscriberReady(),
    };
  }

  async publishIndexedBatch(events: readonly DecodedEvent[]): Promise<void> {
    if (events.length === 0) return;
    for (let offset = 0; offset < events.length; offset += MAX_INDEXED_EVENTS_PER_ENVELOPE) {
      await this.publishIndexedChunk(
        events.slice(offset, offset + MAX_INDEXED_EVENTS_PER_ENVELOPE),
      );
    }
  }

  private async publishIndexedChunk(events: readonly DecodedEvent[]): Promise<void> {
    const envelope: IndexedBatchEnvelope = {
      schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
      deployment: this.#deployment,
      producerId: this.#producerId,
      messageId: this.#createMessageId(),
      kind: 'indexed.batch',
      events: [...events],
    };
    let serialized: string;
    try {
      serialized = encodePublicEventEnvelope(envelope);
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
    await this.publishSerialized(serialized);
  }

  async publishServerEvent(event: ServerEvent, ts: number): Promise<void> {
    await this.publish({
      schemaVersion: PUBLIC_EVENT_SCHEMA_VERSION,
      deployment: this.#deployment,
      producerId: this.#producerId,
      messageId: this.#createMessageId(),
      kind: 'server.event',
      event,
      ts,
    });
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    await this.#dispatchTail.catch(() => undefined);
    await this.options.transport.close().catch(() => undefined);
  }

  private async publish(envelope: PublicEventEnvelope): Promise<void> {
    if (
      this.#closing ||
      !this.#started ||
      !this.options.transport.isPublisherReady()
    ) {
      this.#health.dropped += 1;
      return;
    }
    let serialized: string;
    try {
      serialized = encodePublicEventEnvelope(envelope);
    } catch {
      this.recordError();
      this.#health.dropped += 1;
      return;
    }
    await this.publishSerialized(serialized);
  }

  private async publishSerialized(serialized: string): Promise<void> {
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
        let envelope: PublicEventEnvelope;
        try {
          envelope = decodePublicEventEnvelope(serialized, this.#deployment);
        } catch {
          this.#health.rejected += 1;
          return;
        }
        if (envelope.producerId === this.#producerId) return;
        this.#health.received += 1;
        if (envelope.kind === 'indexed.batch') {
          await this.options.handlers?.onIndexedBatch(envelope.events);
        } else {
          await this.options.handlers?.onServerEvent(envelope.event, envelope.ts);
        }
      })
      .catch(() => {
        this.recordError();
      });
  }

  private recordError(): void {
    this.#health.errors += 1;
  }
}

export function createDisabledPublicEventPlane(): PublicEventPlane {
  const health: PublicEventsHealth = {
    status: 'disabled',
    publisherReady: false,
    subscriberReady: false,
    published: 0,
    received: 0,
    rejected: 0,
    dropped: 0,
    errors: 0,
  };
  return {
    start: () => undefined,
    publishIndexedBatch: async () => undefined,
    publishServerEvent: async () => undefined,
    getHealth: () => ({ ...health }),
    close: async () => undefined,
  };
}
