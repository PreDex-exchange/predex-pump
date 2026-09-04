import type { PrismaClient } from '@prisma/client';
import type { ServerEvent } from '@predex-pump/shared';

import {
  getActivityById,
  getFillDto,
  getMarketDto,
  getOrderDto,
  getPositionDto,
  getResolutionForMarket,
  getSeedOrders,
  getTradeDto,
  findMarketForToken,
} from '../api/queries.js';
import {
  bigintArg,
  bigintArrayArg,
  lowerAddress,
  stringArg,
} from '../indexer/derive.js';
import type { DecodedEvent } from '../indexer/types.js';
import type { ServerEventBus } from './bus.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function eventId(event: DecodedEvent): string {
  return `${event.txHash}:${event.logIndex}`;
}

function eventKey(event: DecodedEvent): string {
  return `${event.source}.${event.eventName}`;
}

async function marketIdForEvent(
  prisma: PrismaClient,
  event: DecodedEvent,
): Promise<string | null> {
  if (typeof event.args.marketId === 'bigint') {
    return event.args.marketId.toString();
  }
  if (typeof event.args.conditionId === 'string') {
    const market = await prisma.market.findUnique({
      where: { conditionId: event.args.conditionId.toLowerCase() },
      select: { id: true },
    });
    return market?.id ?? null;
  }
  if (typeof event.args.questionId === 'string') {
    const market = await prisma.market.findFirst({
      where: { questionId: event.args.questionId.toLowerCase() },
      select: { id: true },
    });
    return market?.id ?? null;
  }
  if (typeof event.args.orderId === 'bigint') {
    const order = await prisma.order.findUnique({
      where: { orderId: event.args.orderId.toString() },
      select: { marketId: true },
    });
    return order?.marketId ?? null;
  }
  if (typeof event.args.orderHash === 'string') {
    const order = await prisma.signedOrder.findUnique({
      where: { orderHash: event.args.orderHash.toLowerCase() },
      select: { marketId: true },
    });
    return order?.marketId ?? null;
  }
  return null;
}

function publish(eventBus: ServerEventBus, event: ServerEvent, ts: number): void {
  eventBus.publish(event, ts);
}

async function publishMarketUpdated(
  prisma: PrismaClient,
  eventBus: ServerEventBus,
  marketId: string,
  ts: number,
): Promise<void> {
  if (!eventBus.hasSubscribers('markets')) return;
  const market = await getMarketDto(prisma, marketId);
  if (market !== null) {
    publish(
      eventBus,
      { channel: 'markets', event: 'market.updated', data: market },
      ts,
    );
  }
}

async function publishPosition(
  prisma: PrismaClient,
  eventBus: ServerEventBus,
  account: string,
  marketId: string,
  outcome: string,
  ts: number,
): Promise<void> {
  if (account === ZERO_ADDRESS) return;
  const channel = `account:${account}` as const;
  if (!eventBus.hasSubscribers(channel)) return;
  const position = await getPositionDto(prisma, account, marketId, outcome);
  if (position === null) return;
  publish(
    eventBus,
    {
      channel,
      event: 'position.updated',
      data: position,
    },
    ts,
  );
}

async function publishTransferPositions(
  prisma: PrismaClient,
  eventBus: ServerEventBus,
  event: DecodedEvent,
): Promise<void> {
  const subscribedAccounts = new Set(
    eventBus
      .subscribedChannels('account:')
      .map((channel) => channel.slice('account:'.length)),
  );
  if (subscribedAccounts.size === 0) return;
  const tokenIds =
    event.eventName === 'TransferBatch'
      ? bigintArrayArg(event.args, 'ids')
      : [bigintArg(event.args, 'id')];
  const accounts = [
    lowerAddress(stringArg(event.args, 'from')),
    lowerAddress(stringArg(event.args, 'to')),
  ].filter((account) => subscribedAccounts.has(account));
  if (accounts.length === 0) return;
  const published = new Set<string>();
  for (const tokenId of tokenIds) {
    const binding = await findMarketForToken(prisma, tokenId.toString());
    if (binding === null) continue;
    for (const account of accounts) {
      const identity = `${account}:${binding.market.id}:${binding.outcome}`;
      if (published.has(identity)) continue;
      published.add(identity);
      await publishPosition(
        prisma,
        eventBus,
        account,
        binding.market.id,
        binding.outcome,
        event.ts,
      );
    }
  }
}

async function publishMarketPositions(
  prisma: PrismaClient,
  eventBus: ServerEventBus,
  marketId: string,
  ts: number,
): Promise<void> {
  const subscribedAccounts = eventBus
    .subscribedChannels('account:')
    .map((channel) => channel.slice('account:'.length));
  if (subscribedAccounts.length === 0) return;
  const positions = await prisma.position.findMany({
    where: { marketId, account: { in: subscribedAccounts } },
    select: { account: true, outcome: true },
  });
  for (const position of positions) {
    await publishPosition(
      prisma,
      eventBus,
      position.account,
      marketId,
      position.outcome,
      ts,
    );
  }
}

async function publishSignedBookUpdatesForMakers(
  prisma: PrismaClient,
  eventBus: ServerEventBus,
  makers: readonly string[],
  ts: number,
  reason: 'FILLABILITY_CHANGED' | 'EXCHANGE_EVENT',
): Promise<void> {
  const normalized = [...new Set(makers.filter((maker) => maker !== ZERO_ADDRESS))];
  if (normalized.length === 0) return;
  const orders = await prisma.signedOrder.findMany({
    where: { maker: { in: normalized } },
    select: { marketId: true },
    distinct: ['marketId'],
  });
  for (const { marketId } of orders) {
    const channel = `book:${marketId}` as const;
    if (!eventBus.hasSubscribers(channel)) continue;
    publish(
      eventBus,
      { channel, event: 'book.updated', data: { marketId, reason } },
      ts,
    );
  }
}

function addressArgs(event: DecodedEvent, names: readonly string[]): string[] {
  return names.flatMap((name) => {
    const value = event.args[name];
    return typeof value === 'string' ? [lowerAddress(value)] : [];
  });
}

const MARKET_UPDATED_EVENTS = new Set([
  'REGISTRY.MarketParameterSnapshot',
  'REGISTRY.MarketTokenBinding',
  'REGISTRY.MarketGraduationBinding',
  'REGISTRY.MarketGraduationBookSeeded',
  'REGISTRY.MarketResolutionObserved',
  'REGISTRY.MarketClosedOut',
  'LMSR.TradeExecuted',
  'LMSR.TradeState',
  'LMSR.ResolutionObserved',
  'LMSR.MarketCloseout',
  'MINI_CLOB.OrderFilled',
  'ORACLE.QuestionResolved',
  'CTF.ConditionResolution',
]);

async function publishSpecificEvent(
  prisma: PrismaClient,
  eventBus: ServerEventBus,
  indexedEvent: DecodedEvent,
): Promise<void> {
  const key = eventKey(indexedEvent);
  const marketId = await marketIdForEvent(prisma, indexedEvent);

  if (
    key === 'REGISTRY.MarketCreated' &&
    marketId !== null &&
    eventBus.hasSubscribers('markets')
  ) {
    const market = await getMarketDto(prisma, marketId);
    if (market !== null) {
      publish(
        eventBus,
        { channel: 'markets', event: 'market.created', data: market },
        indexedEvent.ts,
      );
    }
  }

  if (
    key === 'REGISTRY.MarketGraduated' &&
    marketId !== null &&
    (eventBus.hasSubscribers('markets') ||
      eventBus.hasSubscribers(`market:${marketId}`))
  ) {
    const market = await getMarketDto(prisma, marketId);
    if (market !== null) {
      publish(
        eventBus,
        { channel: 'markets', event: 'market.graduated', data: market },
        indexedEvent.ts,
      );
      publish(
        eventBus,
        {
          channel: `market:${marketId}`,
          event: 'graduated',
          data: market,
        },
        indexedEvent.ts,
      );
    }
  } else if (marketId !== null && MARKET_UPDATED_EVENTS.has(key)) {
    await publishMarketUpdated(prisma, eventBus, marketId, indexedEvent.ts);
  }

  if (key === 'LMSR.TradeState' && marketId !== null) {
    if (eventBus.hasSubscribers(`market:${marketId}`)) {
      const point = await prisma.pricePoint.findUnique({
        where: { id: eventId(indexedEvent) },
      });
      if (point !== null) {
        publish(
          eventBus,
          {
            channel: `market:${marketId}`,
            event: 'price.tick',
            data: {
              marketId,
              yesPriceRaw: point.yesPriceRaw,
              noPriceRaw: point.noPriceRaw,
              ts: point.ts,
            },
          },
          indexedEvent.ts,
        );
      }
    }
    await publishMarketPositions(prisma, eventBus, marketId, indexedEvent.ts);
  }

  if (
    (key === 'LMSR.TradeExecuted' || key === 'MINI_CLOB.OrderFilled') &&
    marketId !== null
  ) {
    const candidateAccount =
      key === 'LMSR.TradeExecuted'
        ? lowerAddress(stringArg(indexedEvent.args, 'trader'))
        : lowerAddress(stringArg(indexedEvent.args, 'taker'));
    const trade =
      eventBus.hasSubscribers(`market:${marketId}`) ||
      eventBus.hasSubscribers(`account:${candidateAccount}`)
        ? await getTradeDto(prisma, eventId(indexedEvent))
        : null;
    if (trade !== null) {
      publish(
        eventBus,
        { channel: `market:${marketId}`, event: 'trade', data: trade },
        indexedEvent.ts,
      );
      publish(
        eventBus,
        {
          channel: `account:${trade.account}`,
          event: 'trade',
          data: trade,
        },
        indexedEvent.ts,
      );
    }
  }

  if (
    key === 'MINI_CLOB.OrderPlaced' &&
    marketId !== null &&
    eventBus.hasSubscribers(`book:${marketId}`)
  ) {
    const order = await getOrderDto(
      prisma,
      bigintArg(indexedEvent.args, 'orderId').toString(),
    );
    if (order !== null) {
      publish(
        eventBus,
        {
          channel: `book:${marketId}`,
          event: 'order.placed',
          data: order,
        },
        indexedEvent.ts,
      );
    }
  }

  if (
    key === 'MINI_CLOB.OrderFilled' &&
    marketId !== null &&
    eventBus.hasSubscribers(`book:${marketId}`)
  ) {
    const fill = await getFillDto(prisma, eventId(indexedEvent));
    if (fill !== null) {
      publish(
        eventBus,
        {
          channel: `book:${marketId}`,
          event: 'order.filled',
          data: fill,
        },
        indexedEvent.ts,
      );
    }
  }

  if (
    key === 'MINI_CLOB.OrderCancelled' &&
    marketId !== null &&
    eventBus.hasSubscribers(`book:${marketId}`)
  ) {
    const order = await getOrderDto(
      prisma,
      bigintArg(indexedEvent.args, 'orderId').toString(),
    );
    if (order !== null) {
      publish(
        eventBus,
        {
          channel: `book:${marketId}`,
          event: 'order.cancelled',
          data: order,
        },
        indexedEvent.ts,
      );
    }
  }

  if (
    key === 'REGISTRY.MarketGraduationBookSeeded' &&
    marketId !== null &&
    eventBus.hasSubscribers(`book:${marketId}`)
  ) {
    publish(
      eventBus,
      {
        channel: `book:${marketId}`,
        event: 'book.seeded',
        data: {
          marketId,
          orders: await getSeedOrders(prisma, marketId),
        },
      },
      indexedEvent.ts,
    );
  }

  if (
    key === 'MINI_CLOB.ConditionCutover' &&
    marketId !== null &&
    eventBus.hasSubscribers(`book:${marketId}`)
  ) {
    publish(
      eventBus,
      {
        channel: `book:${marketId}`,
        event: 'book.updated',
        data: { marketId, reason: 'EXCHANGE_EVENT' },
      },
      indexedEvent.ts,
    );
  }

  if (key === 'CTF.TransferSingle' || key === 'CTF.TransferBatch') {
    await publishTransferPositions(prisma, eventBus, indexedEvent);
    await publishSignedBookUpdatesForMakers(
      prisma,
      eventBus,
      addressArgs(indexedEvent, ['from', 'to']),
      indexedEvent.ts,
      'FILLABILITY_CHANGED',
    );
  }

  if (
    key === 'CTF.ApprovalForAll' ||
    key === 'COLLATERAL.Approval' ||
    key === 'COLLATERAL.Transfer'
  ) {
    await publishSignedBookUpdatesForMakers(
      prisma,
      eventBus,
      addressArgs(indexedEvent, ['account', 'owner', 'from', 'to']),
      indexedEvent.ts,
      'FILLABILITY_CHANGED',
    );
  }

  if (
    marketId !== null &&
    (key === 'CTF_EXCHANGE.OrderFilled' ||
      key === 'CTF_EXCHANGE.OrderCancelled')
  ) {
    const channel = `book:${marketId}` as const;
    if (eventBus.hasSubscribers(channel)) {
      publish(
        eventBus,
        {
          channel,
          event: 'book.updated',
          data: { marketId, reason: 'EXCHANGE_EVENT' },
        },
        indexedEvent.ts,
      );
    }
  }

  if (key === 'CTF_EXCHANGE.AllOrdersCancelled') {
    await publishSignedBookUpdatesForMakers(
      prisma,
      eventBus,
      addressArgs(indexedEvent, ['maker']),
      indexedEvent.ts,
      'EXCHANGE_EVENT',
    );
  }

  if (
    marketId !== null &&
    (key === 'ORACLE.QuestionResolved' ||
      key === 'CTF.ConditionResolution' ||
      key === 'LMSR.ResolutionObserved')
  ) {
    if (eventBus.hasSubscribers(`market:${marketId}`)) {
      const resolution = await getResolutionForMarket(prisma, marketId);
      if (resolution !== null) {
        publish(
          eventBus,
          {
            channel: `market:${marketId}`,
            event: 'resolution',
            data: resolution,
          },
          indexedEvent.ts,
        );
      }
    }
    await publishMarketPositions(prisma, eventBus, marketId, indexedEvent.ts);
    const bookChannel = `book:${marketId}` as const;
    if (eventBus.hasSubscribers(bookChannel)) {
      publish(
        eventBus,
        {
          channel: bookChannel,
          event: 'book.updated',
          data: { marketId, reason: 'EXCHANGE_EVENT' },
        },
        indexedEvent.ts,
      );
    }
  }

  const activity = eventBus.hasSubscribers('activity')
    ? await getActivityById(prisma, eventId(indexedEvent))
    : null;
  if (activity !== null) {
    publish(
      eventBus,
      { channel: 'activity', event: 'activity', data: activity },
      indexedEvent.ts,
    );
  }
}

export async function publishIndexedEvents(
  prisma: PrismaClient,
  eventBus: ServerEventBus,
  indexedEvents: readonly DecodedEvent[],
): Promise<void> {
  for (const indexedEvent of indexedEvents) {
    await publishSpecificEvent(prisma, eventBus, indexedEvent);
  }
}
