import type { PrismaClient } from '@prisma/client';
import {
  routes,
  type AccountResponse,
  type ActivityResponse,
  type ConfigResponse,
  type DedupCheckResponse,
  type HealthResponse,
  type ListMarketsResponse,
  type MarketBookResponse,
  type MarketDetailResponse,
  type OrderBookResponse,
  type PriceHistoryResponse,
} from '@predex-pump/shared';
import type { FastifyInstance } from 'fastify';

import { unavailableDedupResponse } from '../dedup/service.js';
import type { DedupChecker } from '../dedup/types.js';
import {
  HttpError,
  parseAddress,
  parseDecimalId,
  parseMarketPhase,
  parseNonNegativeInteger,
  parseOptionalAddress,
  parseOptionalString,
  parsePositiveInteger,
} from './input.js';
import {
  createCachedConfigReader,
  getAccount,
  getHealth,
  getMarketBook,
  getMarketDetail,
  getOrderBook,
  getPriceHistory,
  listActivity,
  listMarkets,
} from './queries.js';

interface MarketsQuerystring {
  phase?: string;
  creator?: string;
  limit?: string;
  cursor?: string;
}

interface PricesQuerystring {
  fromTs?: string;
  limit?: string;
}

interface ActivityQuerystring {
  marketId?: string;
  account?: string;
  limit?: string;
  cursor?: string;
}

interface IdParams {
  id: string;
}

interface TokenParams {
  tokenId: string;
}

interface AccountParams {
  addr: string;
}

function parseDedupQuestion(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be an object');
  }
  const question = (body as Record<string, unknown>).question;
  if (typeof question !== 'string' || question.trim() === '') {
    throw new HttpError(400, 'question must be a non-empty string');
  }
  return question.trim();
}

function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

export function registerRestRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  dedupChecker: DedupChecker,
): void {
  const readConfig = createCachedConfigReader(prisma);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    app.log.error(error);
    void reply.code(500).send({ error: 'Internal server error' });
  });

  app.get<{ Querystring: MarketsQuerystring }>(
    routes.markets(),
    async (request): Promise<ListMarketsResponse> => {
      const phase = parseMarketPhase(request.query.phase);
      const creator = parseOptionalAddress('creator', request.query.creator);
      const cursor = parseOptionalString(request.query.cursor);
      return listMarkets(prisma, {
        ...(phase === undefined ? {} : { phase }),
        ...(creator === undefined ? {} : { creator }),
        limit: parsePositiveInteger('limit', request.query.limit, 50, 200),
        ...(cursor === undefined ? {} : { cursor }),
      });
    },
  );

  app.post<{ Body: unknown }>(
    routes.marketDedupCheck(),
    async (request): Promise<DedupCheckResponse> => {
      const question = parseDedupQuestion(request.body);
      try {
        return await dedupChecker.check(question);
      } catch (error) {
        request.log.warn({ err: error }, 'Dedup check failed open');
        return unavailableDedupResponse();
      }
    },
  );

  app.get<{ Params: IdParams }>(
    routes.market(':id'),
    async (request): Promise<MarketDetailResponse> => {
      const marketId = parseDecimalId('market id', request.params.id);
      const response = await getMarketDetail(prisma, marketId);
      if (response === null) throw notFound(`Market ${marketId} was not found`);
      return response;
    },
  );

  app.get<{ Params: IdParams }>(
    routes.marketBook(':id'),
    async (request): Promise<MarketBookResponse> => {
      const marketId = parseDecimalId('market id', request.params.id);
      const response = await getMarketBook(prisma, marketId);
      if (response === null) throw notFound(`Market ${marketId} was not found`);
      return response;
    },
  );

  app.get<{ Params: IdParams; Querystring: PricesQuerystring }>(
    routes.marketPrices(':id'),
    async (request): Promise<PriceHistoryResponse> => {
      const marketId = parseDecimalId('market id', request.params.id);
      const response = await getPriceHistory(
        prisma,
        marketId,
        parseNonNegativeInteger('fromTs', request.query.fromTs),
        parsePositiveInteger('limit', request.query.limit, 500, 2_000),
      );
      if (response === null) throw notFound(`Market ${marketId} was not found`);
      return response;
    },
  );

  app.get<{ Params: TokenParams }>(
    routes.orderbook(':tokenId'),
    async (request): Promise<OrderBookResponse> => {
      const tokenId = parseDecimalId('token id', request.params.tokenId);
      const response = await getOrderBook(prisma, tokenId);
      if (response === null) throw notFound(`Token ${tokenId} was not found`);
      return response;
    },
  );

  app.get<{ Params: AccountParams }>(
    routes.account(':addr'),
    async (request): Promise<AccountResponse> =>
      getAccount(prisma, parseAddress('account address', request.params.addr)),
  );

  app.get<{ Querystring: ActivityQuerystring }>(
    routes.activity(),
    async (request): Promise<ActivityResponse> => {
      const rawMarketId = parseOptionalString(request.query.marketId);
      const marketId =
        rawMarketId === undefined
          ? undefined
          : parseDecimalId('marketId', rawMarketId);
      const account = parseOptionalAddress('account', request.query.account);
      const cursor = parseOptionalString(request.query.cursor);
      return listActivity(prisma, {
        ...(marketId === undefined ? {} : { marketId }),
        ...(account === undefined ? {} : { account }),
        limit: parsePositiveInteger('limit', request.query.limit, 50, 200),
        ...(cursor === undefined ? {} : { cursor }),
      });
    },
  );

  app.get(routes.config(), async (): Promise<ConfigResponse> => {
    const response = await readConfig();
    if (response === null) {
      throw new HttpError(503, 'Registry config has not been indexed yet');
    }
    return response;
  });

  app.get(routes.health(), async (): Promise<HealthResponse> => getHealth(prisma));
}
