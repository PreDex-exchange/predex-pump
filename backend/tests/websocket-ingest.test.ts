import { ADDRESSES, type WsOutbound } from '@predex-pump/shared';
import type { Address, Hex } from 'viem';
import { WebSocket } from 'ws';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/api/server.js';
import { ServerEventBus } from '../src/events/bus.js';
import { publishIndexedEvents } from '../src/events/projector.js';
import { applyDecodedEvents } from '../src/indexer/runner.js';
import type { DecodedEvent } from '../src/indexer/types.js';
import { resetDatabase, testPrisma } from './database.js';
import { seedContractData } from './fixtures.js';

function nextMessage(socket: WebSocket): Promise<WsOutbound> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off('message', onMessage);
      reject(error);
    };
    const onMessage = (raw: WebSocket.RawData): void => {
      socket.off('error', onError);
      resolve(JSON.parse(raw.toString()) as WsOutbound);
    };
    socket.once('error', onError);
    socket.once('message', onMessage);
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

describe('WebSocket indexer bridge', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedContractData();
  });

  it('broadcasts the matching ServerEvent after an ingest transaction commits', async () => {
    const eventBus = new ServerEventBus();
    const app = await buildServer({
      prisma: testPrisma,
      eventBus,
      logger: false,
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws`);

    try {
      await waitForOpen(socket);
      const ackPromise = nextMessage(socket);
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          channels: ['market:1'],
        }),
      );
      await expect(ackPromise).resolves.toEqual({
        type: 'ack',
        channels: ['market:1'],
      });

      const indexedEvent: DecodedEvent = {
        source: 'LMSR',
        address: ADDRESSES.lmsr as Address,
        eventName: 'TradeState',
        args: {
          marketId: 1n,
          qYesRawAfter: 100_000n,
          qNoRawAfter: 0n,
          FCommittedRawAfter: 1_000_000n,
          bCurrentWadAfter: 1_442_695_040_888_963_406n,
          inventoryYesRawAfter: 5_000_000n,
          inventoryNoRawAfter: 5_000_000n,
          splitAmountRaw: 0n,
          mergeAmountRaw: 0n,
          graduationMoneyInRawAfter: 2_000_000n,
        },
        txHash: `0x${'f'.repeat(64)}` as Hex,
        logIndex: 7,
        blockNumber: 110,
        ts: 1_700_000_200,
      };

      const updatePromise = nextMessage(socket);
      const applied = await applyDecodedEvents(
        testPrisma,
        [indexedEvent],
        110,
        110,
        (events) => publishIndexedEvents(testPrisma, eventBus, events),
      );
      expect(applied).toBe(1);
      await expect(updatePromise).resolves.toEqual({
        type: 'update',
        channel: 'market:1',
        event: 'price.tick',
        data: {
          marketId: '1',
          yesPriceRaw: '517321',
          noPriceRaw: '482679',
          ts: 1_700_000_200,
        },
        ts: 1_700_000_200,
      });
      expect(
        await testPrisma.pricePoint.findUnique({
          where: { id: `${indexedEvent.txHash}:7` },
        }),
      ).not.toBeNull();
      expect(
        await testPrisma.position.findUnique({
          where: {
            account_marketId_outcome: {
              account: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              marketId: '1',
              outcome: 'YES',
            },
          },
          select: { unrealizedPnlRaw: true },
        }),
      ).toEqual({ unrealizedPnlRaw: '334642' });
      expect(
        await testPrisma.account.findUnique({
          where: {
            address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
          select: { realizedPnlRaw: true, unrealizedPnlRaw: true },
        }),
      ).toEqual({
        realizedPnlRaw: '100000',
        unrealizedPnlRaw: '334642',
      });
    } finally {
      await waitForClose(socket);
      await app.close();
    }
  });

  it('enforces the channel cap across cumulative subscribe frames', async () => {
    const eventBus = new ServerEventBus();
    const app = await buildServer({
      prisma: testPrisma,
      eventBus,
      logger: false,
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws`);
    const initialChannels = Array.from(
      { length: 200 },
      (_, index) => `market:${index + 1}`,
    );

    try {
      await waitForOpen(socket);
      const initialAck = nextMessage(socket);
      socket.send(
        JSON.stringify({ type: 'subscribe', channels: initialChannels }),
      );
      await expect(initialAck).resolves.toEqual({
        type: 'ack',
        channels: initialChannels,
      });

      const rejected = nextMessage(socket);
      socket.send(
        JSON.stringify({ type: 'subscribe', channels: ['book:201'] }),
      );
      await expect(rejected).resolves.toEqual({
        type: 'error',
        message: 'A connection may subscribe to at most 200 channels',
      });
      expect(eventBus.hasSubscribers('market:1')).toBe(true);
      expect(eventBus.hasSubscribers('market:200')).toBe(true);
      expect(eventBus.hasSubscribers('book:201')).toBe(false);
    } finally {
      await waitForClose(socket);
      await app.close();
    }
  });
});
