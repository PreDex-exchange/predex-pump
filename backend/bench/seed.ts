import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADDRESSES, ARC, DEPLOY_BLOCK } from '@predex-pump/shared';
import type { Prisma } from '@prisma/client';

import {
  address,
  benchDatabaseUrl,
  benchSchema,
  generatedBatches,
  hasFlag,
  hash,
  inBatches,
  resetBenchSchema,
  scaleFromArgs,
  dropBenchSchema,
  makePrisma,
  type Scale,
} from './support.js';

const BASE_TS = 1_750_000_000;
const BASE_BLOCK = 60_000_000;
const INSERT_BATCH = 1_000;
const ACTIVE_HYBRID_TRADING_ENDS_AT = 2_100_000_000;
const HOT_HYBRID_SIGNED_ORDERS = 400;
const HOT_HYBRID_MAKER_CAPACITY_RAW = '1000000000000';
const EOA_SIGNATURE = `0x${'ab'.repeat(65)}`;
const ACTIVITY_TYPES = [
  'MarketCreated',
  'Trade',
  'MarketGraduated',
  'BookSeeded',
  'OrderPlaced',
  'OrderFilled',
  'OrderCancelled',
  'ResolutionObserved',
  'Closeout',
  'Redeem',
] as const;
const PHASES = ['Opened', 'Graduated', 'ResolvedObserved', 'ClosedOut'] as const;

interface PositionSeed {
  accountIndex: number;
  marketIndex: number;
  outcome: 'YES' | 'NO';
}

function marketForTrade(index: number, scale: Scale): number {
  const hot = Math.min(scale.trades, Math.max(1_000, Math.floor(scale.trades * 0.05)));
  if (index < hot) return 0;
  return scale.markets === 1 ? 0 : 1 + ((index - hot) % (scale.markets - 1));
}

function accountForTrade(index: number, scale: Scale): number {
  const hot = Math.min(scale.trades, Math.max(2_000, Math.floor(scale.trades * 0.1)));
  if (index < hot) return 0;
  return 1 + ((index * 7_919) % Math.max(1, scale.accounts - 1));
}

function yesPrice(marketIndex: number): bigint {
  return BigInt(300_000 + ((marketIndex * 7_919) % 400_001));
}

function phaseForMarket(marketIndex: number): (typeof PHASES)[number] {
  return PHASES[(marketIndex + 1) % PHASES.length] ?? 'Opened';
}

function resolutionPrice(
  marketIndex: number,
  outcome: 'YES' | 'NO',
): bigint | null {
  const phase = phaseForMarket(marketIndex);
  if (phase !== 'ResolvedObserved' && phase !== 'ClosedOut') return null;
  const resolution = marketIndex % 3;
  if (resolution === 2) return 500_000n;
  const yesWins = resolution === 0;
  return (outcome === 'YES') === yesWins ? 1_000_000n : 0n;
}

function makePositionSeeds(scale: Scale): PositionSeed[] {
  const rows: PositionSeed[] = [];
  const seen = new Set<string>();
  const add = (
    accountIndex: number,
    marketIndex: number,
    outcome: 'YES' | 'NO',
  ): void => {
    if (rows.length >= scale.positions) return;
    const key = `${accountIndex}:${marketIndex}:${outcome}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ accountIndex, marketIndex, outcome });
  };

  // One dense account exercises the complete portfolio response.
  const denseMarkets = Math.min(scale.markets, 500);
  for (let marketIndex = 0; marketIndex < denseMarkets; marketIndex += 1) {
    add(0, marketIndex, 'YES');
    add(0, marketIndex, 'NO');
  }

  // One dense market makes TradeState re-marking representative during ingest.
  const denseMarketAccounts = Math.min(scale.accounts, 250);
  for (let accountIndex = 0; accountIndex < denseMarketAccounts; accountIndex += 1) {
    add(accountIndex, 0, 'YES');
    add(accountIndex, 0, 'NO');
  }

  let slot = 0;
  while (rows.length < scale.positions) {
    for (
      let accountIndex = 0;
      accountIndex < scale.accounts && rows.length < scale.positions;
      accountIndex += 1
    ) {
      const marketIndex = (accountIndex * 97 + slot * 193) % scale.markets;
      add(accountIndex, marketIndex, (accountIndex + slot) % 2 === 0 ? 'YES' : 'NO');
    }
    slot += 1;
  }
  return rows;
}

export async function seedBenchmarkSingletons(
  prisma: ReturnType<typeof makePrisma>,
): Promise<void> {
  await prisma.registryConfig.create({
    data: {
      id: 1,
      chainId: ARC.chainId,
      usdcAddress: ADDRESSES.usdc.toLowerCase(),
      ctfAddress: ADDRESSES.ctf.toLowerCase(),
      oracleAddress: ADDRESSES.oracle.toLowerCase(),
      lmsrAddress: ADDRESSES.lmsr.toLowerCase(),
      registryAddress: ADDRESSES.registry.toLowerCase(),
      miniClobAddress: ADDRESSES.miniClob.toLowerCase(),
      marketTypeVersion: 2,
      currentLmsrAddress: ADDRESSES.lmsr.toLowerCase(),
      openingFeeRaw: '1000000',
      seedFloorRaw: '1000000',
      seedCapRaw: '50000000',
      fCapRaw: '100000000',
      graduationMoneyInThresholdRaw: '25000000',
      graduationTollRaw: '2000000',
      inventoryTargetRaw: '5000000',
      defaultTradingWindowSeconds: 86_400,
      minTradingWindowSeconds: 3_600,
      maxTradingWindowSeconds: 604_800,
      minimumTimeOpenSeconds: 3_600,
      protocolFeeBps: 100,
      depthFeeBps: 50,
      committeeThreshold: 2,
      updatedBlock: BASE_BLOCK,
    },
  });
  await prisma.registeredMarketType.create({
    data: {
      version: 2,
      lmsrAddress: ADDRESSES.lmsr.toLowerCase(),
      configHash: hash(2),
      registeredAt: BASE_TS,
      blockNumber: BASE_BLOCK,
      logIndex: 0,
    },
  });
  await prisma.indexerState.create({
    data: {
      id: 1,
      chainId: ARC.chainId,
      deployBlock: DEPLOY_BLOCK,
      lastBlock: BASE_BLOCK,
      headBlock: BASE_BLOCK,
    },
  });
  await prisma.committeeMember.createMany({
    data: Array.from({ length: 9 }, (_, index) => ({
      address: address(900_000 + index),
      active: index < 7,
      addedAt: BASE_TS + index,
      ...(index < 7 ? {} : { removedAt: BASE_TS + 100 + index }),
      updatedBlock: BASE_BLOCK + index,
    })),
  });
}

async function maybeBackfillAccountRollups(
  prisma: ReturnType<typeof makePrisma>,
  schema: string,
): Promise<void> {
  const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = ${schema}
      AND table_name = 'Account'
      AND column_name IN ('realizedPnlRaw', 'unrealizedPnlRaw')
  `;
  if (columns.length !== 2) return;
  await prisma.$executeRawUnsafe(`
    UPDATE "${schema}"."Account" AS account
    SET
      "realizedPnlRaw" = totals.realized,
      "unrealizedPnlRaw" = totals.unrealized
    FROM (
      SELECT
        "account",
        COALESCE(SUM(("realizedPnlRaw")::numeric), 0)::text AS realized,
        COALESCE(SUM(("unrealizedPnlRaw")::numeric), 0)::text AS unrealized
      FROM "${schema}"."Position"
      GROUP BY "account"
    ) AS totals
    WHERE account."address" = totals."account"
  `);
}

async function seedHotHybridBook(
  prisma: ReturnType<typeof makePrisma>,
): Promise<void> {
  const maker = address(0).toLowerCase();
  const conditionId = hash(3_000_000);
  const yesTokenId = '1000000000';
  const noTokenId = '1000000001';
  await prisma.market.update({
    where: { id: '1' },
    data: {
      phase: 'Graduated',
      bookAddress: ADDRESSES.miniClob.toLowerCase(),
      yesSeedOrderId: '1',
      noSeedOrderId: '2',
      tradingEndsAt: ACTIVE_HYBRID_TRADING_ENDS_AT,
      resolvedAt: null,
      closedOutAt: null,
    },
  });
  await prisma.order.updateMany({
    where: { marketId: '1' },
    data: { open: false },
  });
  await prisma.bookMigration.create({
    data: {
      marketId: '1',
      status: 'MIGRATED',
      yesSeedOrderId: '1',
      noSeedOrderId: '2',
      registrationStatus: 'CONFIRMED',
      approvalStatus: 'CONFIRMED',
      yesCancelStatus: 'CONFIRMED',
      noCancelStatus: 'CONFIRMED',
      createdAt: BASE_TS + 3_600,
      updatedAt: BASE_TS + 7_200,
      cancelledAt: BASE_TS + 7_100,
      migratedAt: BASE_TS + 7_200,
    },
  });
  for (const outcome of ['YES', 'NO'] as const) {
    await prisma.position.upsert({
      where: {
        account_marketId_outcome: { account: maker, marketId: '1', outcome },
      },
      create: {
        account: maker,
        marketId: '1',
        outcome,
        qtyRaw: HOT_HYBRID_MAKER_CAPACITY_RAW,
        costBasisRaw: '0',
        realizedPnlRaw: '0',
        unrealizedPnlRaw: '0',
        updatedAt: BASE_TS + 7_200,
      },
      update: {
        qtyRaw: HOT_HYBRID_MAKER_CAPACITY_RAW,
        updatedAt: BASE_TS + 7_200,
      },
    });
  }
  await prisma.exchangeTokenRegistration.createMany({
    data: [
      {
        tokenId: yesTokenId,
        complementTokenId: noTokenId,
        conditionId,
        blockNumber: BASE_BLOCK,
        logIndex: 0,
        registeredAt: BASE_TS + 7_200,
      },
      {
        tokenId: noTokenId,
        complementTokenId: yesTokenId,
        conditionId,
        blockNumber: BASE_BLOCK,
        logIndex: 1,
        registeredAt: BASE_TS + 7_200,
      },
    ],
  });
  await Promise.all([
    prisma.ctfExchangeApproval.create({
      data: {
        owner: maker,
        approved: true,
        blockNumber: BASE_BLOCK,
        logIndex: 0,
        updatedAt: BASE_TS,
      },
    }),
    prisma.collateralExchangeApproval.create({
      data: {
        owner: maker,
        allowanceRaw: HOT_HYBRID_MAKER_CAPACITY_RAW,
        blockNumber: BASE_BLOCK,
        logIndex: 0,
        updatedAt: BASE_TS,
      },
    }),
    prisma.collateralBalance.create({
      data: {
        owner: maker,
        balanceRaw: HOT_HYBRID_MAKER_CAPACITY_RAW,
        blockNumber: BASE_BLOCK,
        logIndex: 0,
        updatedAt: BASE_TS,
      },
    }),
  ]);
  await generatedBatches<Prisma.SignedOrderCreateManyInput>(
    HOT_HYBRID_SIGNED_ORDERS,
    INSERT_BATCH,
    (index) => {
      const outcome = index % 2 === 0 ? 'YES' : 'NO';
      const exchangeSide = Math.floor(index / 2) % 2;
      const priceRaw = BigInt(300_000 + ((index * 7_919) % 400_001));
      const sizeRaw = 1_000_000n;
      return {
        orderHash: hash(70_000_000 + index),
        saltRaw: String(80_000_000 + index),
        maker,
        signer: maker,
        taker: '0x0000000000000000000000000000000000000000',
        tokenId: outcome === 'YES' ? yesTokenId : noTokenId,
        makerAmountRaw: (exchangeSide === 0 ? priceRaw : sizeRaw).toString(),
        takerAmountRaw: (exchangeSide === 0 ? sizeRaw : priceRaw).toString(),
        expiration: ACTIVE_HYBRID_TRADING_ENDS_AT,
        nonceRaw: '0',
        feeRateBpsRaw: '0',
        exchangeSide,
        signatureType: 0,
        signature: EOA_SIGNATURE,
        marketId: '1',
        conditionId,
        outcome,
        side: exchangeSide === 0 ? 'BID' : 'ASK',
        priceRaw: priceRaw.toString(),
        sizeRaw: sizeRaw.toString(),
        filledRaw: '0',
        remainingRaw: sizeRaw.toString(),
        status: 'OPEN',
        origin: 'USER',
        createdAt: BASE_TS + 7_200 + index,
        updatedAt: BASE_TS + 7_200 + index,
      };
    },
    (data) => prisma.signedOrder.createMany({ data }),
    'hot Hybrid signed orders',
  );
}

async function seed(scale: Scale, databaseUrl: string): Promise<void> {
  const prisma = makePrisma(databaseUrl);
  const startedAt = performance.now();
  try {
    await seedBenchmarkSingletons(prisma);

    const marketTradeCounts = new Int32Array(scale.markets);
    const marketVolumes = Array.from({ length: scale.markets }, () => 0n);
    const accountTradeCounts = new Int32Array(scale.accounts);
    for (let index = 0; index < scale.trades; index += 1) {
      const marketIndex = marketForTrade(index, scale);
      const accountIndex = accountForTrade(index, scale);
      marketTradeCounts[marketIndex] = (marketTradeCounts[marketIndex] ?? 0) + 1;
      accountTradeCounts[accountIndex] = (accountTradeCounts[accountIndex] ?? 0) + 1;
      marketVolumes[marketIndex] =
        (marketVolumes[marketIndex] ?? 0n) + BigInt(500_000 + (index % 1_500_000));
    }

    await generatedBatches<Prisma.AccountCreateManyInput>(
      scale.accounts,
      INSERT_BATCH,
      (index) => ({
        address: address(index),
        firstSeenAt: BASE_TS + (index % 86_400),
        marketsCreated: index < scale.markets ? 1 : 0,
        tradeCount: accountTradeCounts[index] ?? 0,
      }),
      (data) => prisma.account.createMany({ data }),
      'accounts',
    );

    await generatedBatches<Prisma.MarketCreateManyInput>(
      scale.markets,
      INSERT_BATCH,
      (index) => {
        const id = String(index + 1);
        const phase = phaseForMarket(index);
        const yes = yesPrice(index);
        const resolved =
          phase === 'ResolvedObserved' || phase === 'ClosedOut';
        const graduated = phase !== 'Opened';
        return {
          id,
          creator: address(index % scale.accounts),
          question: `Synthetic benchmark market ${id}: will outcome YES occur?`,
          ancillaryData: `0x${Buffer.from(`Synthetic benchmark market ${id}`).toString(
            'hex',
          )}`,
          ancillaryDataHash: hash(1_000_000 + index),
          metadataHash: hash(2_000_000 + index),
          phase,
          conditionId: hash(3_000_000 + index),
          questionId: hash(4_000_000 + index),
          marketTypeVersion: 2,
          collateralAddress: ADDRESSES.usdc.toLowerCase(),
          collateralDecimals: 6,
          yesTokenId: String(1_000_000_000 + index * 2),
          noTokenId: String(1_000_000_001 + index * 2),
          seedRaw: String(1_000_000 + (index % 50) * 1_000_000),
          yesPriceRaw: yes.toString(),
          noPriceRaw: (1_000_000n - yes).toString(),
          graduationActivityRaw: String((index % 40) * 1_000_000),
          bookAddress: graduated ? ADDRESSES.miniClob.toLowerCase() : null,
          frozenYesPriceRaw: graduated ? yes.toString() : null,
          handoffSizeRaw: graduated ? '5000000' : null,
          tradeCount: marketTradeCounts[index] ?? 0,
          volumeRaw: (marketVolumes[index] ?? 0n).toString(),
          openingFeeRaw: '1000000',
          seedFloorRaw: '1000000',
          seedCapRaw: '50000000',
          fCapRaw: '100000000',
          graduationThresholdRaw: '25000000',
          graduationTollRaw: '2000000',
          inventoryTargetRaw: '5000000',
          protocolFeeBps: 100,
          depthFeeBps: 50,
          tradingWindowSeconds: 86_400,
          minimumTimeOpenSeconds: 3_600,
          qYesRaw: String((index % 100) * 100_000),
          qNoRaw: String((index % 80) * 100_000),
          fundingCommittedRaw: '10000000',
          bCurrentWad: '1442695040888963406',
          inventoryYesRaw: '5000000',
          inventoryNoRaw: '5000000',
          createdAt: BASE_TS + index * 60,
          tradingEndsAt:
            index === 0
              ? ACTIVE_HYBRID_TRADING_ENDS_AT
              : BASE_TS + index * 60 + 86_400,
          graduatedAt: graduated ? BASE_TS + index * 60 + 3_600 : null,
          resolvedAt: resolved ? BASE_TS + index * 60 + 7_200 : null,
          closedOutAt: phase === 'ClosedOut' ? BASE_TS + index * 60 + 10_800 : null,
        };
      },
      (data) => prisma.market.createMany({ data }),
      'markets',
    );

    const resolvedMarkets = Array.from(
      { length: scale.markets },
      (_, index) => index,
    ).filter((index) => {
      const phase = phaseForMarket(index);
      return phase === 'ResolvedObserved' || phase === 'ClosedOut';
    });
    await inBatches(resolvedMarkets, INSERT_BATCH, async (indexes) => {
      await prisma.resolution.createMany({
        data: indexes.map((index) => {
          const invalid = index % 3 === 2;
          const yesWins = index % 3 === 0;
          return {
            marketId: String(index + 1),
            conditionId: hash(3_000_000 + index),
            outcome: invalid ? 'INVALID' : yesWins ? 'YES' : 'NO',
            payoutYes: invalid || yesWins ? 1 : 0,
            payoutNo: invalid || !yesWins ? 1 : 0,
            denominator: invalid ? 2 : 1,
            resolvedAt: BASE_TS + index * 60 + 7_200,
            observedAt: BASE_TS + index * 60 + 7_300,
            txHash: hash(5_000_000 + index),
            logIndex: 0,
          };
        }),
      });
    });

    const positionSeeds = makePositionSeeds(scale);
    await generatedBatches<Prisma.PositionCreateManyInput>(
      positionSeeds.length,
      INSERT_BATCH,
      (index) => {
        const seed = positionSeeds[index];
        if (seed === undefined) throw new Error(`Missing position seed ${index}`);
        const qty = BigInt(1_000_000 + (index % 20) * 100_000);
        const basis = BigInt(350_000 + (index % 10) * 70_000);
        const markPrice =
          resolutionPrice(seed.marketIndex, seed.outcome) ??
          (seed.outcome === 'YES'
            ? yesPrice(seed.marketIndex)
            : 1_000_000n - yesPrice(seed.marketIndex));
        return {
          account: address(seed.accountIndex),
          marketId: String(seed.marketIndex + 1),
          outcome: seed.outcome,
          qtyRaw: qty.toString(),
          costBasisRaw: basis.toString(),
          realizedPnlRaw: String((index % 11) * 10_000 - 30_000),
          unrealizedPnlRaw: ((qty * markPrice) / 1_000_000n - basis).toString(),
          updatedAt: BASE_TS + (index % 604_800),
        };
      },
      (data) => prisma.position.createMany({ data }),
      'positions',
    );
    await generatedBatches<Prisma.TradeCreateManyInput>(
      scale.trades,
      INSERT_BATCH,
      (index) => {
        const marketIndex = marketForTrade(index, scale);
        const accountIndex = accountForTrade(index, scale);
        const outcome = index % 2 === 0 ? 'YES' : 'NO';
        const side = index % 3 === 0 ? 'ASK' : 'BID';
        const size = BigInt(1_000_000 + (index % 10) * 100_000);
        const price =
          outcome === 'YES' ? yesPrice(marketIndex) : 1_000_000n - yesPrice(marketIndex);
        const cost = (size * price) / 1_000_000n;
        const txHash = hash(10_000_000 + index);
        return {
          id: `${txHash}:0`,
          marketId: String(marketIndex + 1),
          venue: index % 5 === 0 ? 'BOOK' : 'LMSR',
          account: address(accountIndex),
          recipient: address(accountIndex),
          outcome,
          side,
          sizeRaw: size.toString(),
          priceRaw: price.toString(),
          costRaw: cost.toString(),
          feeRaw: String(index % 10_000),
          baseAmountRaw: cost.toString(),
          protocolFeeRaw: String(index % 4_000),
          depthContributionRaw: String(index % 6_000),
          totalCostRaw: side === 'BID' ? cost.toString() : '0',
          netProceedsRaw: side === 'ASK' ? cost.toString() : '0',
          txHash,
          logIndex: 0,
          blockNumber: BASE_BLOCK + Math.floor(index / 10),
          ts: BASE_TS + Math.floor(index / 10),
        };
      },
      (data) => prisma.trade.createMany({ data }),
      'trades',
    );

    const hotPrices = Math.min(
      scale.pricePoints,
      Math.max(2_000, Math.floor(scale.pricePoints * 0.05)),
    );
    await generatedBatches<Prisma.PricePointCreateManyInput>(
      scale.pricePoints,
      INSERT_BATCH,
      (index) => {
        const marketIndex =
          index < hotPrices
            ? 0
            : scale.markets === 1
              ? 0
              : 1 + ((index - hotPrices) % (scale.markets - 1));
        const yes = BigInt(250_000 + ((index * 3571) % 500_001));
        const txHash = hash(20_000_000 + index);
        return {
          id: `${txHash}:0`,
          marketId: String(marketIndex + 1),
          yesPriceRaw: yes.toString(),
          noPriceRaw: (1_000_000n - yes).toString(),
          qYesRaw: String((index % 100) * 100_000),
          qNoRaw: String((index % 80) * 100_000),
          bCurrentWad: '1442695040888963406',
          txHash,
          logIndex: index % 10,
          blockNumber: BASE_BLOCK + Math.floor(index / 10),
          ts: BASE_TS + Math.floor(index / 5),
        };
      },
      (data) => prisma.pricePoint.createMany({ data }),
      'price points',
    );

    const hotOrders = Math.min(
      scale.orders,
      Math.max(500, Math.floor(scale.orders * 0.01)),
    );
    await generatedBatches<Prisma.OrderCreateManyInput>(
      scale.orders,
      INSERT_BATCH,
      (index) => {
        const marketIndex =
          index < hotOrders
            ? 0
            : scale.markets === 1
              ? 0
              : 1 + ((index - hotOrders) % (scale.markets - 1));
        const outcome = index % 2 === 0 ? 'YES' : 'NO';
        const side = index % 4 < 2 ? 'BID' : 'ASK';
        const size = BigInt(1_000_000 + (index % 20) * 100_000);
        const filled = index % 3 === 0 ? size / 4n : 0n;
        const txHash = hash(30_000_000 + index);
        return {
          orderId: String(index + 1),
          marketId: String(marketIndex + 1),
          conditionId: hash(3_000_000 + marketIndex),
          tokenId: String(
            1_000_000_000 + marketIndex * 2 + (outcome === 'YES' ? 0 : 1),
          ),
          outcome,
          maker: address((index * 97) % scale.accounts),
          side,
          priceRaw: String(100_000 + ((index * 7_919) % 800_001)),
          sizeRaw: size.toString(),
          escrowRaw: size.toString(),
          filledRaw: filled.toString(),
          remainingRaw: (size - filled).toString(),
          open: marketIndex === 0 ? false : index % 4 !== 0,
          isSeed: index < 2,
          txHash,
          logIndex: 0,
          blockNumber: BASE_BLOCK + Math.floor(index / 10),
          createdAt: BASE_TS + Math.floor(index / 5),
          updatedAt: BASE_TS + Math.floor(index / 5) + (filled > 0n ? 60 : 0),
        };
      },
      (data) => prisma.order.createMany({ data }),
      'orders',
    );

    await seedHotHybridBook(prisma);
    await maybeBackfillAccountRollups(prisma, benchSchema(databaseUrl));

    await generatedBatches<Prisma.FillCreateManyInput>(
      scale.fills,
      INSERT_BATCH,
      (index) => {
        const orderIndex = index % scale.orders;
        const marketIndex =
          orderIndex < hotOrders
            ? 0
            : scale.markets === 1
              ? 0
              : 1 + ((orderIndex - hotOrders) % (scale.markets - 1));
        const fillSize = BigInt(100_000 + (index % 10) * 10_000);
        const payment = (fillSize * BigInt(300_000 + (index % 400_000))) / 1_000_000n;
        const txHash = hash(40_000_000 + index);
        return {
          id: `${txHash}:0`,
          orderId: String(orderIndex + 1),
          marketId: String(marketIndex + 1),
          taker: address((index * 31) % scale.accounts),
          maker: address((orderIndex * 97) % scale.accounts),
          outcome: orderIndex % 2 === 0 ? 'YES' : 'NO',
          fillSizeRaw: fillSize.toString(),
          paymentRaw: payment.toString(),
          filledAfterRaw: fillSize.toString(),
          openAfter: true,
          txHash,
          logIndex: 0,
          blockNumber: BASE_BLOCK + Math.floor(index / 10),
          ts: BASE_TS + Math.floor(index / 5),
        };
      },
      (data) => prisma.fill.createMany({ data }),
      'fills',
    );

    const hotActivity = Math.min(
      scale.activityEvents,
      Math.max(10_000, Math.floor(scale.activityEvents * 0.05)),
    );
    await generatedBatches<Prisma.ActivityEventCreateManyInput>(
      scale.activityEvents,
      INSERT_BATCH,
      (index) => {
        const marketIndex =
          index < hotActivity
            ? 0
            : scale.markets === 1
              ? 0
              : 1 + ((index - hotActivity) % (scale.markets - 1));
        const accountIndex =
          index < hotActivity
            ? 0
            : 1 + ((index * 104_729) % Math.max(1, scale.accounts - 1));
        const type = ACTIVITY_TYPES[index % ACTIVITY_TYPES.length] ?? 'Trade';
        const txHash = hash(50_000_000 + index);
        return {
          id: `${txHash}:${index % 10}`,
          type,
          eventName: type,
          source: index % 2 === 0 ? 'LMSR' : 'REGISTRY',
          marketId: String(marketIndex + 1),
          account: address(accountIndex),
          outcome: index % 2 === 0 ? 'YES' : 'NO',
          side: index % 3 === 0 ? 'ASK' : 'BID',
          amountRaw: String(1_000_000 + (index % 1_000_000)),
          priceRaw: String(100_000 + (index % 800_001)),
          txHash,
          logIndex: index % 10,
          blockNumber: BASE_BLOCK + Math.floor(index / 10),
          ts: BASE_TS + Math.floor(index / 10),
          data: { synthetic: true },
        };
      },
      (data) => prisma.activityEvent.createMany({ data }),
      'activity events',
    );

    await prisma.$executeRawUnsafe('ANALYZE');

    const durationSeconds = (performance.now() - startedAt) / 1_000;
    const summary = {
      generatedAt: new Date().toISOString(),
      databaseSchema: benchSchema(databaseUrl),
      syntheticOnly: true,
      scale,
      durationSeconds,
      hotRows: {
        marketOneTrades: marketTradeCounts[0] ?? 0,
        marketOnePricePoints: hotPrices,
        marketOneOrders: hotOrders,
        marketOneSignedOrders: HOT_HYBRID_SIGNED_ORDERS,
        marketOneActivityEvents: hotActivity,
        denseAccount: address(0),
      },
    };
    await mkdir(resolve('bench/results'), { recursive: true });
    await writeFile(
      resolve('bench/results/scale.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.info(
      `[seed] complete schema=${summary.databaseSchema} duration=${durationSeconds.toFixed(
        1,
      )}s`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const databaseUrl = benchDatabaseUrl(argv);
  if (hasFlag(argv, 'teardown')) {
    await dropBenchSchema(databaseUrl);
    console.info(`[seed] dropped isolated schema ${benchSchema(databaseUrl)}`);
    return;
  }
  const scale = scaleFromArgs(argv);
  console.info(
    `[seed] resetting isolated schema=${benchSchema(databaseUrl)} scale=${JSON.stringify(
      scale,
    )}`,
  );
  await resetBenchSchema(databaseUrl);
  await seed(scale, databaseUrl);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error('[seed] failed', error);
    process.exitCode = 1;
  });
}
