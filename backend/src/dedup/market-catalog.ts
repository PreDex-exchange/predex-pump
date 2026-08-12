import type { PrismaClient } from '@prisma/client';

import type { CanonicalMarket, MarketCatalog } from './types.js';

/** Reads canonical market identity from Postgres instead of trusting Qdrant. */
export class PrismaMarketCatalog implements MarketCatalog {
  constructor(private readonly prisma: PrismaClient) {}

  async listMarketIds(): Promise<string[]> {
    const markets = await this.prisma.market.findMany({
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return markets.map(({ id }) => id);
  }

  async findMarketsByIds(
    marketIds: readonly string[],
  ): Promise<CanonicalMarket[]> {
    if (marketIds.length === 0) return [];
    const markets = await this.prisma.market.findMany({
      where: { id: { in: [...new Set(marketIds)] } },
      select: { id: true, question: true },
    });
    return markets.map((market) => ({
      marketId: market.id,
      question: market.question,
    }));
  }
}
