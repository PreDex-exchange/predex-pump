import type {
  AccountProfileResponse,
  RecordAccountBehaviorResponse,
  SessionResponse,
  SiweNonceResponse,
  SiweVerifyRequest,
  UpdateAccountProfileRequest,
  WatchlistMutationResponse,
} from '@predex-pump/shared';
import { routes } from '@predex-pump/shared';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import {
  AccountService,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from '../account/service.js';
import { HttpError, parseDecimalId } from './input.js';

interface MarketParams {
  marketId: string;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be an object');
  }
  return body as Record<string, unknown>;
}

function rejectUnknownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new HttpError(400, `${unknown} is not stored by this endpoint`);
}

function parseVerifyBody(body: unknown): SiweVerifyRequest {
  const input = objectBody(body);
  rejectUnknownFields(input, ['message', 'signature']);
  if (typeof input.message !== 'string' || typeof input.signature !== 'string') {
    throw new HttpError(400, 'message and signature must be strings');
  }
  return {
    message: input.message,
    signature: input.signature as `0x${string}`,
  };
}

function parseProfileUpdate(body: unknown): {
  displayName?: string | null;
  rememberRecentlyViewed?: boolean;
} {
  const input = objectBody(body);
  rejectUnknownFields(input, ['displayName', 'preferences']);
  const update: {
    displayName?: string | null;
    rememberRecentlyViewed?: boolean;
  } = {};

  if (input.displayName !== undefined) {
    if (input.displayName !== null && typeof input.displayName !== 'string') {
      throw new HttpError(400, 'displayName must be a string or null');
    }
    const displayName = input.displayName?.trim() || null;
    if (displayName && displayName.length > 40) {
      throw new HttpError(400, 'displayName must be at most 40 characters');
    }
    update.displayName = displayName;
  }

  if (input.preferences !== undefined) {
    const preferences = objectBody(input.preferences);
    rejectUnknownFields(preferences, ['rememberRecentlyViewed']);
    if (
      preferences.rememberRecentlyViewed !== undefined &&
      typeof preferences.rememberRecentlyViewed !== 'boolean'
    ) {
      throw new HttpError(400, 'rememberRecentlyViewed must be boolean');
    }
    if (typeof preferences.rememberRecentlyViewed === 'boolean') {
      update.rememberRecentlyViewed = preferences.rememberRecentlyViewed;
    }
  }

  if (Object.keys(update).length === 0) {
    throw new HttpError(400, 'No supported profile fields were provided');
  }
  return update;
}

function parseBehaviorBody(body: unknown): {
  type: string;
  marketId: string;
} {
  const input = objectBody(body);
  rejectUnknownFields(input, ['type', 'marketId']);
  if (typeof input.type !== 'string') {
    throw new HttpError(400, 'type must be a string');
  }
  return {
    type: input.type,
    marketId: parseDecimalId('marketId', input.marketId),
  };
}

async function requireAddress(
  service: AccountService,
  request: FastifyRequest,
): Promise<string> {
  const session = await service.session(request.headers.cookie);
  if (!session) throw new HttpError(401, 'Sign in with the connected wallet first');
  return session.address;
}

function privateResponse(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store');
}

export function registerAccountRoutes(
  app: FastifyInstance,
  service: AccountService,
): void {
  app.post(
    routes.siweNonce(),
    async (_request, reply): Promise<SiweNonceResponse> => {
      privateResponse(reply);
      return service.issueNonce();
    },
  );

  app.post<{ Body: unknown }>(
    routes.siweVerify(),
    async (request, reply): Promise<SessionResponse> => {
      const input = parseVerifyBody(request.body);
      const verified = await service.verify(input.message, input.signature);
      privateResponse(reply).header(
        'set-cookie',
        serializeSessionCookie(
          verified.token,
          new Date(verified.response.expiresAt),
          service.config,
        ),
      );
      return verified.response;
    },
  );

  app.get(
    routes.session(),
    async (request, reply): Promise<SessionResponse> => {
      privateResponse(reply);
      return service.sessionResponse(request.headers.cookie);
    },
  );

  app.post(
    routes.signOut(),
    async (request, reply): Promise<SessionResponse> => {
      await service.signOut(request.headers.cookie);
      privateResponse(reply).header(
        'set-cookie',
        serializeClearedSessionCookie(service.config),
      );
      return { authenticated: false };
    },
  );

  app.get(
    routes.accountProfile(),
    async (request, reply): Promise<AccountProfileResponse> => {
      const address = await requireAddress(service, request);
      privateResponse(reply);
      return service.profile(address);
    },
  );

  app.patch<{ Body: UpdateAccountProfileRequest }>(
    routes.accountProfile(),
    async (request, reply): Promise<AccountProfileResponse> => {
      const address = await requireAddress(service, request);
      const input = parseProfileUpdate(request.body);
      privateResponse(reply);
      return service.updateProfile(address, input);
    },
  );

  app.put<{ Params: MarketParams }>(
    routes.accountWatchlist(':marketId'),
    async (request, reply): Promise<WatchlistMutationResponse> => {
      const address = await requireAddress(service, request);
      const marketId = parseDecimalId('marketId', request.params.marketId);
      privateResponse(reply);
      return service.setWatchlist(address, marketId, true);
    },
  );

  app.delete<{ Params: MarketParams }>(
    routes.accountWatchlist(':marketId'),
    async (request, reply): Promise<WatchlistMutationResponse> => {
      const address = await requireAddress(service, request);
      const marketId = parseDecimalId('marketId', request.params.marketId);
      privateResponse(reply);
      return service.setWatchlist(address, marketId, false);
    },
  );

  app.post<{ Body: unknown }>(
    routes.accountBehavior(),
    async (request, reply): Promise<RecordAccountBehaviorResponse> => {
      const address = await requireAddress(service, request);
      const input = parseBehaviorBody(request.body);
      privateResponse(reply);
      return service.recordBehavior(address, input.type, input.marketId);
    },
  );
}
