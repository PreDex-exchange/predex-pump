const TRANSIENT_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const RPC_ERROR_NAMES = new Set([
  'HttpRequestError',
  'RpcRequestError',
  'SocketClosedError',
  'TimeoutError',
  'WebSocketRequestError',
]);

const RATE_LIMIT_PATTERN =
  /(?:public endpoint rate limit|rate[ -]?limit|too many requests|request limit exceeded)/iu;
const TRANSIENT_MESSAGE_PATTERN =
  /(?:connection (?:closed|refused|reset)|dns|fetch failed|gateway timeout|getaddrinfo|network error|socket hang up|temporarily unavailable|timed? out|timeout)/iu;

export const RPC_RETRY_POLICY = {
  baseDelayMs: 1_000,
  rateLimitBaseDelayMs: 5_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
} as const;

export interface RpcErrorDetails {
  kind: 'rate-limit' | 'transient';
  retryAfterMs: number | undefined;
  summary: string;
}

interface ErrorRecord {
  cause?: unknown;
  code?: unknown;
  data?: unknown;
  details?: unknown;
  headers?: unknown;
  message?: unknown;
  name?: unknown;
  shortMessage?: unknown;
  status?: unknown;
  statusCode?: unknown;
}

function isRecord(value: unknown): value is ErrorRecord {
  return typeof value === 'object' && value !== null;
}

function errorChain(error: unknown): ErrorRecord[] {
  const chain: ErrorRecord[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  while (isRecord(current) && chain.length < 12 && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return Number(value);
  return undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  if ('get' in headers && typeof headers.get === 'function') {
    const value = (headers.get as (headerName: string) => unknown)(name);
    return stringValue(value);
  }
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  const value = entry?.[1];
  if (Array.isArray(value)) return stringValue(value[0]);
  return stringValue(value);
}

export function parseRetryAfterMs(
  value: string | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(normalized)) {
    return Math.max(0, Math.ceil(Number(normalized) * 1_000));
  }
  const retryAt = Date.parse(normalized);
  return Number.isNaN(retryAt) ? undefined : Math.max(0, retryAt - nowMs);
}

function errorText(record: ErrorRecord): string {
  return [record.details, record.shortMessage, record.message]
    .map(stringValue)
    .filter((value): value is string => value !== undefined)
    .join(' ');
}

function safeSummary(chain: readonly ErrorRecord[]): string {
  const record =
    chain.find((candidate) => RATE_LIMIT_PATTERN.test(errorText(candidate))) ??
    chain[0];
  if (record === undefined) return 'unknown RPC error';
  const name = stringValue(record.name) ?? 'Error';
  const code = numberValue(record.code);
  const status = numberValue(record.status) ?? numberValue(record.statusCode);
  const text = errorText(record)
    .replace(/https?:\/\/\S+/giu, '[rpc-url]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240);
  return [
    name,
    code === undefined ? undefined : `code=${code}`,
    status === undefined ? undefined : `status=${status}`,
    text,
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(' ');
}

export function inspectRpcError(
  error: unknown,
  nowMs = Date.now(),
): RpcErrorDetails | null {
  const chain = errorChain(error);
  if (chain.length === 0) return null;

  const codes = chain
    .flatMap((record) => [
      numberValue(record.code),
      isRecord(record.data) ? numberValue(record.data.code) : undefined,
    ])
    .filter((value): value is number => value !== undefined);
  const statuses = chain
    .flatMap((record) => [
      numberValue(record.status),
      numberValue(record.statusCode),
    ])
    .filter((value): value is number => value !== undefined);
  const names = chain
    .map((record) => stringValue(record.name))
    .filter((value): value is string => value !== undefined);
  const messages = chain.map(errorText).join(' ');
  const errorCodes = chain
    .map((record) => stringValue(record.code)?.toUpperCase())
    .filter((value): value is string => value !== undefined);
  const retryAfterMs = chain
    .map((record) =>
      parseRetryAfterMs(headerValue(record.headers, 'retry-after'), nowMs),
    )
    .find((value) => value !== undefined);

  const rateLimited =
    statuses.includes(429) ||
    codes.includes(-32_005) ||
    codes.includes(15) ||
    RATE_LIMIT_PATTERN.test(messages);
  const retryable =
    rateLimited ||
    names.some((name) => RPC_ERROR_NAMES.has(name)) ||
    errorCodes.some((code) => TRANSIENT_ERROR_CODES.has(code)) ||
    statuses.some((status) => status === 408 || status === 425 || status >= 500) ||
    TRANSIENT_MESSAGE_PATTERN.test(messages);
  if (!retryable) return null;

  return {
    kind: rateLimited ? 'rate-limit' : 'transient',
    retryAfterMs,
    summary: safeSummary(chain),
  };
}

export function retryDelayMs(
  attempt: number,
  error: RpcErrorDetails,
  random: () => number = Math.random,
): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const baseDelay =
    error.kind === 'rate-limit'
      ? RPC_RETRY_POLICY.rateLimitBaseDelayMs
      : RPC_RETRY_POLICY.baseDelayMs;
  const exponent = Math.min(normalizedAttempt - 1, 30);
  const exponentialDelay = Math.min(
    RPC_RETRY_POLICY.maxDelayMs,
    baseDelay * 2 ** exponent,
  );
  const jitterCapacity = Math.min(
    RPC_RETRY_POLICY.maxDelayMs - exponentialDelay,
    exponentialDelay * RPC_RETRY_POLICY.jitterRatio,
  );
  const randomUnit = Math.min(1, Math.max(0, random()));
  const jitteredDelay = Math.ceil(exponentialDelay + jitterCapacity * randomUnit);
  const retryAfterDelay = error.retryAfterMs ?? 0;
  // The locally computed exponential schedule is capped. A server-provided
  // Retry-After is an explicit lower bound and may extend beyond that cap.
  return Math.max(jitteredDelay, retryAfterDelay);
}
