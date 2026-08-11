import type { PrismaClient } from '@prisma/client';
import {
  routes,
  type AccountResponse,
  type ActivityResponse,
  type ConfigResponse,
  type ExchangeApprovalStateResponse,
  type DedupCheckResponse,
  type HealthResponse,
  type ListMarketsResponse,
  type MarketBookResponse,
  type MarketDetailResponse,
  type OrderBookResponse,
  type PriceHistoryResponse,
  type TruthSignalResponse,
} from '@predex-pump/shared';
import type { FastifyInstance } from 'fastify';

import { unavailableDedupResponse } from '../dedup/service.js';
import type { DedupChecker } from '../dedup/types.js';
import { DEFAULT_INDEXER_STALL_MS } from '../config.js';
import {
  encodePaymentHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type TruthPaymentGate,
} from '../truth-payment/types.js';
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
  getExchangeApprovalState,
  getHealth,
  getMarketBook,
  getMarketDetail,
  getOrderBook,
  getPriceHistory,
  getTruthSignal,
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

interface TruthParams {
  marketId: string;
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
  indexerStallMs = DEFAULT_INDEXER_STALL_MS,
  truthPaymentGate?: TruthPaymentGate,
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

  app.get<{ Params: TruthParams }>(
    routes.truth(':marketId'),
    async (request, reply) => {
      const marketId = parseDecimalId('market id', request.params.marketId);
      const response = await getTruthSignal(prisma, marketId);
      if (response === null) throw notFound(`Market ${marketId} was not found`);
      if (truthPaymentGate === undefined) return response;

      const challenge = truthPaymentGate.paymentRequiredHeader(request.url);
      const paymentSignature = request.headers[PAYMENT_SIGNATURE_HEADER];
      if (typeof paymentSignature !== 'string' || paymentSignature === '') {
        return reply
          .header(PAYMENT_REQUIRED_HEADER, challenge)
          .code(402)
          .send({
            error: 'Payment required for this truth signal.',
          });
      }

      let authorization;
      try {
        authorization = await truthPaymentGate.authorize(
          paymentSignature,
          request.url,
        );
      } catch (error) {
        request.log.warn({ err: error }, 'Truth payment layer unavailable');
        return reply.code(503).send({
          error: 'Truth payment layer is temporarily unavailable.',
        });
      }
      if (!authorization.success) {
        return reply
          .header(PAYMENT_REQUIRED_HEADER, challenge)
          .code(402)
          .send({
            error: 'Truth payment was rejected.',
            reason: authorization.errorReason ?? 'Unknown payment failure.',
          });
      }

      reply.header(
        PAYMENT_RESPONSE_HEADER,
        encodePaymentHeader({
          success: true,
          transaction: authorization.transaction ?? '',
          network: authorization.network,
          payer: authorization.payer ?? '',
        }),
      );
      return response;
    },
  );

  app.get<{ Params: AccountParams }>(
    routes.account(':addr'),
    async (request): Promise<AccountResponse> =>
      getAccount(prisma, parseAddress('account address', request.params.addr)),
  );

  app.get<{ Params: AccountParams }>(
    routes.exchangeApprovals(':addr'),
    async (request, reply): Promise<ExchangeApprovalStateResponse> => {
      reply.header('cache-control', 'no-store');
      return getExchangeApprovalState(
        prisma,
        parseAddress('account address', request.params.addr),
      );
    },
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
      throw new HttpError(
        503,
        'Required chain configuration is unavailable; check indexer health',
      );
    }
    return response;
  });

  app.get(
    routes.health(),
    async (): Promise<HealthResponse> => getHealth(prisma, indexerStallMs),
  );
}
