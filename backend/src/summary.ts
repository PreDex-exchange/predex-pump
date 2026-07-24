import 'dotenv/config';

import { prisma } from './db.js';

async function main(): Promise<void> {
  const [state, markets, totals, config, members] = await Promise.all([
    prisma.indexerState.findUnique({ where: { id: 1 } }),
    prisma.market.findMany({
      orderBy: { id: 'asc' },
      include: {
        resolution: true,
        closeout: true,
        _count: {
          select: {
            trades: true,
            fills: true,
            orders: true,
            pricePoints: true,
            positions: true,
          },
        },
      },
    }),
    Promise.all([
      prisma.trade.count(),
      prisma.fill.count(),
      prisma.order.count(),
      prisma.resolution.count(),
      prisma.activityEvent.count(),
      prisma.position.count(),
    ]),
    prisma.registryConfig.findUnique({ where: { id: 1 } }),
    prisma.committeeMember.findMany({
      where: { active: true },
      orderBy: { address: 'asc' },
      select: { address: true },
    }),
  ]);

  const [trades, fills, orders, resolutions, activityEvents, positions] = totals;
  const output = {
    indexer: state
      ? {
          deployBlock: state.deployBlock,
          lastBlock: state.lastBlock,
          headBlock: state.headBlock,
          lag: Math.max(0, state.headBlock - state.lastBlock),
        }
      : null,
    totals: {
      markets: markets.length,
      trades,
      fills,
      orders,
      resolutions,
      activityEvents,
      positions,
    },
    config: config
      ? {
          marketTypeVersion: config.marketTypeVersion,
          seedFloorRaw: config.seedFloorRaw,
          seedCapRaw: config.seedCapRaw,
          minTradingWindowSeconds: config.minTradingWindowSeconds,
          maxTradingWindowSeconds: config.maxTradingWindowSeconds,
          committeeThreshold: config.committeeThreshold,
          committeeSigners: members.map(({ address }) => address),
        }
      : null,
    markets: markets.map((market) => ({
      marketId: market.id,
      question: market.question,
      phase: market.phase,
      yesPriceRaw: market.yesPriceRaw,
      noPriceRaw: market.noPriceRaw,
      graduationActivityRaw: market.graduationActivityRaw,
      bookAddress: market.bookAddress,
      frozenYesPriceRaw: market.frozenYesPriceRaw,
      handoffSizeRaw: market.handoffSizeRaw,
      tradeCount: market._count.trades,
      fillCount: market._count.fills,
      orderCount: market._count.orders,
      pricePointCount: market._count.pricePoints,
      positionCount: market._count.positions,
      resolution: market.resolution
        ? {
            outcome: market.resolution.outcome,
            payoutYes: market.resolution.payoutYes,
            payoutNo: market.resolution.payoutNo,
            denominator: market.resolution.denominator,
            observedAt: market.resolution.observedAt,
          }
        : null,
      closeout: market.closeout
        ? {
            closedOutAt: market.closeout.closedOutAt,
            fundingResidualRaw: market.closeout.fundingResidualRaw,
            protocolPnlRaw: market.closeout.protocolPnlRaw,
          }
        : null,
    })),
  };

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error('[summary] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
