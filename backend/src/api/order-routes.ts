import type {
  IngestOrderResponse,
  MakerOrdersResponse,
  OrderIngestRejection,
  WithdrawOrderResponse,
} from '@predex-pump/shared';
import { routes } from '@predex-pump/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isHex, size } from 'viem';

import type { AccountService } from '../account/service.js';
import { OrderIngestError, parseIngestOrderRequest } from '../orderbook/input.js';
import {
  OffchainOrderService,
  OrderAccessError,
} from '../orderbook/service.js';
import { HttpError } from './input.js';

interface OrderHashParams {
  orderHash: string;
}

function parseOrderHash(value: string): string {
  if (!isHex(value, { strict: true }) || size(value) !== 32) {
    throw new HttpError(400, 'orderHash must be a 32-byte hex digest');
  }
  return value.toLowerCase();
}

async function requireMaker(
  accounts: AccountService,
  cookie: string | undefined,
): Promise<string> {
  const session = await accounts.session(cookie);
  if (session === null) {
    throw new HttpError(401, 'Sign in with the connected wallet first');
  }
  return session.address;
}

export function registerOrderRoutes(
  app: FastifyInstance,
  orders: OffchainOrderService,
  accounts: AccountService,
): void {
  app.post<{ Body: unknown }>(
    routes.orders(),
    async (
      request,
      reply,
    ): Promise<IngestOrderResponse | OrderIngestRejection | FastifyReply> => {
      try {
        return await orders.ingest(parseIngestOrderRequest(request.body));
      } catch (error) {
        if (error instanceof OrderIngestError) {
          return reply.code(error.statusCode).send({
            error: { code: error.code, message: error.message },
          } satisfies OrderIngestRejection);
        }
        throw error;
      }
    },
  );

  app.get(
    routes.orders(),
    async (request, reply): Promise<MakerOrdersResponse> => {
      const maker = await requireMaker(accounts, request.headers.cookie);
      reply.header('cache-control', 'no-store');
      return orders.listMakerOrders(maker);
    },
  );

  app.delete<{ Params: OrderHashParams }>(
    routes.order(':orderHash'),
    async (request, reply): Promise<WithdrawOrderResponse | FastifyReply> => {
      const maker = await requireMaker(accounts, request.headers.cookie);
      reply.header('cache-control', 'no-store');
      try {
        return await orders.withdraw(
          parseOrderHash(request.params.orderHash),
          maker,
        );
      } catch (error) {
        if (error instanceof OrderAccessError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
