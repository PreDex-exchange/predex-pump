import { PrismaClient } from '@prisma/client';

export const testPrisma = new PrismaClient();

export async function resetDatabase(): Promise<void> {
  await testPrisma.$transaction([
    testPrisma.fill.deleteMany(),
    testPrisma.trade.deleteMany(),
    testPrisma.pricePoint.deleteMany(),
    testPrisma.order.deleteMany(),
    testPrisma.position.deleteMany(),
    testPrisma.resolution.deleteMany(),
    testPrisma.closeout.deleteMany(),
    testPrisma.activityEvent.deleteMany(),
    testPrisma.market.deleteMany(),
    testPrisma.account.deleteMany(),
    testPrisma.committeeMember.deleteMany(),
    testPrisma.registeredMarketType.deleteMany(),
    testPrisma.registryConfig.deleteMany(),
    testPrisma.indexerState.deleteMany(),
  ]);
}
