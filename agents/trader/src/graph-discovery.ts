const GRAPH_REQUEST_TIMEOUT_MS = 10_000;
const GRAPH_MAX_AGE_SECONDS = 90;
const GRAPH_MAX_FUTURE_SKEW_SECONDS = 30;

const MARKET_DISCOVERY_QUERY = `
  query AgentMarketUniverse($now: BigInt!, $limit: Int!) {
    _meta {
      block {
        number
        timestamp
      }
      hasIndexingErrors
    }
    markets(
      first: $limit
      orderBy: lastTradeAt
      orderDirection: desc
      where: { phase: "GRADUATED", tradingEndsAt_gt: $now }
    ) {
      id
      phase
      tradingEndsAt
      tradeEventCount
      lastTradeAt
      lastTradeBlock
      lastTradeTransaction
      lastTradeVenue
    }
  }
`;

export interface NewOpportunityCandidate {
  marketId: string;
  tradeEventCount: string;
  lastTradeAt: number | null;
  lastTradeBlock: number | null;
  lastTradeTransaction: `0x${string}` | null;
  lastTradeVenue: 'LMSR' | 'MINI_CLOB' | 'CTF_EXCHANGE' | null;
}

export interface NewOpportunityDiscoveryResult {
  blockNumber: number;
  blockTimestamp: number;
  candidates: readonly NewOpportunityCandidate[];
}

export interface NewOpportunityDiscovery {
  discover(nowSeconds: number): Promise<NewOpportunityDiscoveryResult>;
}

interface GraphOpportunityDiscoveryOptions {
  queryUrl: string;
  marketLimit: number;
  fetch?: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Graph discovery returned an invalid ${field}.`);
  }
  return value;
}

function decimalString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`Graph discovery returned an invalid ${field}.`);
  }
  return value;
}

function optionalBigIntNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  const raw = decimalString(value, field);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Graph discovery returned an unsafe ${field}.`);
  }
  return parsed;
}

function optionalHash(
  value: unknown,
  field: string,
): `0x${string}` | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`Graph discovery returned an invalid ${field}.`);
  }
  return value.toLowerCase() as `0x${string}`;
}

function optionalVenue(
  value: unknown,
): NewOpportunityCandidate['lastTradeVenue'] {
  if (value === null) return null;
  if (
    value !== 'LMSR' &&
    value !== 'MINI_CLOB' &&
    value !== 'CTF_EXCHANGE'
  ) {
    throw new Error('Graph discovery returned an invalid lastTradeVenue.');
  }
  return value;
}

function parseCandidate(
  value: unknown,
  nowSeconds: number,
): NewOpportunityCandidate {
  if (!isRecord(value)) {
    throw new Error('Graph discovery returned an invalid market candidate.');
  }
  const marketId = decimalString(value.id, 'market ID');
  if (marketId === '0') {
    throw new Error('Graph discovery returned an invalid market ID.');
  }
  if (value.phase !== 'GRADUATED') {
    throw new Error('Graph discovery returned a non-graduated market candidate.');
  }
  const tradingEndsAt = optionalBigIntNumber(
    value.tradingEndsAt,
    'trading deadline',
  );
  if (tradingEndsAt === null || tradingEndsAt <= nowSeconds) {
    throw new Error('Graph discovery returned an ended market candidate.');
  }
  const tradeEventCount = decimalString(
    value.tradeEventCount,
    'trade event count',
  );
  const lastTradeAt = optionalBigIntNumber(value.lastTradeAt, 'last trade time');
  const lastTradeBlock = optionalBigIntNumber(
    value.lastTradeBlock,
    'last trade block',
  );
  const lastTradeTransaction = optionalHash(
    value.lastTradeTransaction,
    'last trade transaction',
  );
  const lastTradeVenue = optionalVenue(value.lastTradeVenue);
  const evidence = [
    lastTradeAt,
    lastTradeBlock,
    lastTradeTransaction,
    lastTradeVenue,
  ];
  const populatedEvidence = evidence.filter((item) => item !== null).length;
  if (populatedEvidence !== 0 && populatedEvidence !== evidence.length) {
    throw new Error('Graph discovery returned incomplete last-trade evidence.');
  }
  if ((tradeEventCount === '0') !== (populatedEvidence === 0)) {
    throw new Error('Graph discovery returned inconsistent trade evidence.');
  }
  return {
    marketId,
    tradeEventCount,
    lastTradeAt,
    lastTradeBlock,
    lastTradeTransaction,
    lastTradeVenue,
  };
}

function parseDiscoveryResponse(
  value: unknown,
  nowSeconds: number,
  marketLimit: number,
): NewOpportunityDiscoveryResult {
  if (!isRecord(value)) {
    throw new Error('Graph discovery returned invalid JSON.');
  }
  if (
    value.errors !== undefined &&
    (!Array.isArray(value.errors) || value.errors.length > 0)
  ) {
    throw new Error('Graph discovery returned GraphQL errors.');
  }
  if (!isRecord(value.data) || !isRecord(value.data._meta)) {
    throw new Error('Graph discovery omitted metadata.');
  }
  const metadata = value.data._meta;
  if (metadata.hasIndexingErrors !== false || !isRecord(metadata.block)) {
    throw new Error('Graph discovery index is unhealthy.');
  }
  const blockNumber = safeInteger(metadata.block.number, 'indexed block');
  const blockTimestamp = safeInteger(
    metadata.block.timestamp,
    'indexed block timestamp',
  );
  const ageSeconds = nowSeconds - blockTimestamp;
  if (
    ageSeconds > GRAPH_MAX_AGE_SECONDS ||
    ageSeconds < -GRAPH_MAX_FUTURE_SKEW_SECONDS
  ) {
    throw new Error('Graph discovery index is stale.');
  }
  if (!Array.isArray(value.data.markets) || value.data.markets.length > marketLimit) {
    throw new Error('Graph discovery returned an invalid candidate list.');
  }
  const candidates = value.data.markets.map((candidate) =>
    parseCandidate(candidate, nowSeconds),
  );
  const uniqueIds = new Set(candidates.map(({ marketId }) => marketId));
  if (uniqueIds.size !== candidates.length) {
    throw new Error('Graph discovery returned duplicate market IDs.');
  }
  return { blockNumber, blockTimestamp, candidates };
}

export function createGraphOpportunityDiscovery({
  queryUrl,
  marketLimit,
  fetch: fetchOverride,
}: GraphOpportunityDiscoveryOptions): NewOpportunityDiscovery {
  if (!Number.isSafeInteger(marketLimit) || marketLimit <= 0 || marketLimit > 20) {
    throw new Error('Graph discovery market limit must be between 1 and 20.');
  }
  const fetchImpl = fetchOverride ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('Graph discovery requires fetch support.');
  return {
    async discover(nowSeconds) {
      if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
        throw new Error('Graph discovery requires a valid current timestamp.');
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GRAPH_REQUEST_TIMEOUT_MS);
      try {
        let response: Response;
        try {
          response = await fetchImpl(queryUrl, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              query: MARKET_DISCOVERY_QUERY,
              variables: { now: nowSeconds.toString(), limit: marketLimit },
            }),
            signal: controller.signal,
          });
        } catch {
          throw new Error('Graph discovery request failed.');
        }
        if (!response.ok) {
          throw new Error(`Graph discovery returned HTTP ${response.status}.`);
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new Error('Graph discovery returned invalid JSON.');
        }
        return parseDiscoveryResponse(body, nowSeconds, marketLimit);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
