import { ADDRESSES, ARC } from '@predex-pump/shared';
import type { Market, Order, Prisma, SignedOrder } from '@prisma/client';
import type { Address, Hex } from 'viem';

import {
  averagePriceRaw,
  bigintArg,
  bigintArrayArg,
  booleanArg,
  decodeQuestion,
  deriveResolution,
  jsonSafe,
  lowerAddress,
  marginalPricesRaw,
  oppositeSide,
  outcomeFromIndex,
  sideFromIndex,
  stringArg,
  toDbInt,
  tupleArg,
} from './derive.js';
import type { DecodedEvent, EventArgs, Outcome, Side } from './types.js';

type Tx = Prisma.TransactionClient;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const PRICE_SCALE = 1_000_000n;

const PHASE_RANK: Readonly<Record<string, number>> = {
  Opened: 0,
  Graduated: 1,
  ResolvedObserved: 2,
  ClosedOut: 3,
};

const ACTIVITY_TYPE: Readonly<Record<string, string>> = {
  'REGISTRY.MarketCreated': 'MarketCreated',
  'REGISTRY.MarketGraduated': 'MarketGraduated',
  'REGISTRY.MarketGraduationBookSeeded': 'BookSeeded',
  'REGISTRY.MarketResolutionObserved': 'ResolutionObserved',
  'REGISTRY.MarketClosedOut': 'Closeout',
  'LMSR.TradeExecuted': 'Trade',
  'LMSR.ResolutionObserved': 'ResolutionObserved',
  'LMSR.MarketCloseout': 'Closeout',
  'MINI_CLOB.GraduationSeeded': 'BookSeeded',
  'MINI_CLOB.OrderPlaced': 'OrderPlaced',
  'MINI_CLOB.OrderFilled': 'OrderFilled',
  'MINI_CLOB.OrderCancelled': 'OrderCancelled',
  'CTF.PayoutRedemption': 'Redeem',
  'CTF_EXCHANGE.OrderFilled': 'OrderFilled',
  'CTF_EXCHANGE.OrderCancelled': 'OrderCancelled',
  'CTF_EXCHANGE.AllOrdersCancelled': 'OrderCancelled',
};

function eventId(event: DecodedEvent): string {
  return `${event.txHash}:${event.logIndex}`;
}

function key(event: DecodedEvent): string {
  return `${event.source}.${event.eventName}`;
}

function tupleBigint(tuple: Record<string, unknown>, name: string): bigint {
  const value = tuple[name];
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new Error(`Expected integer tuple field ${name}`);
}

async function marketById(tx: Tx, marketId: string): Promise<Market> {
  const market = await tx.market.findUnique({ where: { id: marketId } });
  if (market === null) {
    throw new Error(`Event refers to unknown marketId ${marketId}`);
  }
  return market;
}

async function marketByCondition(tx: Tx, conditionId: string): Promise<Market> {
  const market = await tx.market.findUnique({ where: { conditionId } });
  if (market === null) {
    throw new Error(`Event refers to unknown conditionId ${conditionId}`);
  }
  return market;
}

async function marketForToken(
  tx: Tx,
  tokenId: string,
): Promise<{ market: Market; outcome: Outcome } | null> {
  const market = await tx.market.findFirst({
    where: {
      OR: [{ yesTokenId: tokenId }, { noTokenId: tokenId }],
    },
  });
  if (market === null) return null;
  if (market.yesTokenId === tokenId) return { market, outcome: 'YES' };
  if (market.noTokenId === tokenId) return { market, outcome: 'NO' };
  return null;
}

async function ensureAccount(tx: Tx, address: string, ts: number): Promise<void> {
  if (address === ZERO_ADDRESS) return;
  await tx.account.upsert({
    where: { address },
    create: { address, firstSeenAt: ts },
    update: {},
  });
}

async function advancePhase(tx: Tx, marketId: string, phase: string): Promise<void> {
  const market = await marketById(tx, marketId);
  const currentRank = PHASE_RANK[market.phase];
  const nextRank = PHASE_RANK[phase];
  if (currentRank === undefined || nextRank === undefined) {
    throw new Error(`Unknown market phase transition ${market.phase} -> ${phase}`);
  }
  if (nextRank > currentRank) {
    await tx.market.update({ where: { id: marketId }, data: { phase } });
  }
}

function marketCreatedData(event: DecodedEvent): Prisma.MarketCreateInput {
  const { args } = event;
  const ancillaryData = stringArg(args, 'ancillaryData') as Hex;
  return {
    id: bigintArg(args, 'marketId').toString(),
    creator: lowerAddress(stringArg(args, 'creator')),
    question: decodeQuestion(ancillaryData),
    ancillaryData,
    ancillaryDataHash: stringArg(args, 'ancillaryDataHash').toLowerCase(),
    metadataHash: stringArg(args, 'metadataHash').toLowerCase(),
    phase: 'Opened',
    conditionId: stringArg(args, 'conditionId').toLowerCase(),
    questionId: stringArg(args, 'questionId').toLowerCase(),
    marketTypeVersion: toDbInt(bigintArg(args, 'marketTypeVersion'), 'marketTypeVersion'),
    createdAt: toDbInt(bigintArg(args, 'openedAt'), 'openedAt'),
  };
}

/**
 * Discover market and token identities before applying chronological deltas.
 * CTF calls can emit transfers before the outer registry call emits its binding
 * logs, so this pass makes those transfers attributable without changing their
 * event-order semantics.
 */
export async function preloadMarketIdentities(
  tx: Tx,
  events: readonly DecodedEvent[],
): Promise<void> {
  for (const event of events) {
    if (key(event) !== 'REGISTRY.MarketCreated') continue;
    const data = marketCreatedData(event);
    await tx.market.upsert({
      where: { id: data.id },
      create: data,
      update: {
        creator: data.creator,
        question: data.question,
        ancillaryData: data.ancillaryData,
        ancillaryDataHash: data.ancillaryDataHash,
        metadataHash: data.metadataHash,
        conditionId: data.conditionId,
        questionId: data.questionId,
        marketTypeVersion: data.marketTypeVersion,
        createdAt: data.createdAt,
      },
    });
  }

  for (const event of events) {
    const eventKey = key(event);
    if (
      eventKey !== 'REGISTRY.MarketTokenBinding' &&
      eventKey !== 'REGISTRY.MarketGraduationBinding'
    ) {
      continue;
    }
    const marketId = bigintArg(event.args, 'marketId').toString();
    const data: Prisma.MarketUpdateInput = {
      collateralAddress: lowerAddress(stringArg(event.args, 'collateral')),
      yesTokenId: bigintArg(event.args, 'yesTokenId').toString(),
      noTokenId: bigintArg(event.args, 'noTokenId').toString(),
    };
    if (eventKey === 'REGISTRY.MarketTokenBinding') {
      data.collateralDecimals = toDbInt(
        bigintArg(event.args, 'collateralDecimals'),
        'collateralDecimals',
      );
    }
    await tx.market.update({ where: { id: marketId }, data });
  }

  for (const event of events) {
    if (key(event) !== 'REGISTRY.MarketGraduationBookSeeded') continue;
    const frozenYesPrice = bigintArg(event.args, 'frozenYesPriceRaw');
    await tx.market.update({
      where: { id: bigintArg(event.args, 'marketId').toString() },
      data: {
        bookAddress: lowerAddress(stringArg(event.args, 'miniClob')),
        handoffSizeRaw: bigintArg(event.args, 'sizeRaw').toString(),
        frozenYesPriceRaw: frozenYesPrice.toString(),
        yesPriceRaw: frozenYesPrice.toString(),
        noPriceRaw: (PRICE_SCALE - frozenYesPrice).toString(),
        yesSeedOrderId: bigintArg(event.args, 'yesOrderId').toString(),
        noSeedOrderId: bigintArg(event.args, 'noOrderId').toString(),
      },
    });
  }
}

interface ActivityContext {
  marketId: string | null;
  account: string | null;
  outcome: Outcome | null;
  side: Side | null;
  amountRaw: string | null;
  priceRaw: string | null;
}

async function activityContext(tx: Tx, event: DecodedEvent): Promise<ActivityContext> {
  const { args } = event;
  let market: Market | null = null;
  let order: Order | null = null;
  let signedOrder: SignedOrder | null = null;

  if (typeof args.marketId === 'bigint') {
    market = await tx.market.findUnique({ where: { id: args.marketId.toString() } });
  } else if (typeof args.conditionId === 'string') {
    market = await tx.market.findUnique({
      where: { conditionId: args.conditionId.toLowerCase() },
    });
  } else if (typeof args.questionId === 'string') {
    market = await tx.market.findFirst({
      where: { questionId: args.questionId.toLowerCase() },
    });
  } else if (typeof args.orderId === 'bigint') {
    order = await tx.order.findUnique({ where: { orderId: args.orderId.toString() } });
    if (order !== null) {
      market = await tx.market.findUnique({ where: { id: order.marketId } });
    }
  } else if (typeof args.orderHash === 'string') {
    signedOrder = await tx.signedOrder.findUnique({
      where: { orderHash: args.orderHash.toLowerCase() },
    });
    if (signedOrder !== null) {
      market = await tx.market.findUnique({
        where: { id: signedOrder.marketId },
      });
    }
  } else if (event.eventName === 'TransferSingle' && typeof args.id === 'bigint') {
    const binding = await marketForToken(tx, args.id.toString());
    market = binding?.market ?? null;
  } else if (event.eventName === 'TransferBatch' && Array.isArray(args.ids)) {
    const firstToken = args.ids.find((value) => typeof value === 'bigint');
    if (typeof firstToken === 'bigint') {
      const binding = await marketForToken(tx, firstToken.toString());
      market = binding?.market ?? null;
    }
  }

  let account: string | null = null;
  for (const candidate of [
    'trader',
    'taker',
    'maker',
    'creator',
    'redeemer',
    'observer',
    'signer',
    'actor',
    'to',
    'from',
  ]) {
    const value = args[candidate];
    if (typeof value === 'string' && value.toLowerCase() !== ZERO_ADDRESS) {
      account = value.toLowerCase();
      break;
    }
  }

  let outcome: Outcome | null = null;
  if (typeof args.outcome === 'bigint' || typeof args.outcome === 'number') {
    outcome = outcomeFromIndex(BigInt(args.outcome));
  } else if (order !== null) {
    outcome = order.outcome as Outcome;
  } else if (signedOrder !== null) {
    outcome = signedOrder.outcome as Outcome;
  } else if (typeof args.tokenId === 'bigint' && market !== null) {
    const tokenId = args.tokenId.toString();
    if (market.yesTokenId === tokenId) outcome = 'YES';
    if (market.noTokenId === tokenId) outcome = 'NO';
  }

  let side: Side | null = null;
  if (typeof args.side === 'bigint' || typeof args.side === 'number') {
    side = sideFromIndex(BigInt(args.side));
  } else if (event.eventName === 'OrderFilled' && order !== null) {
    side = oppositeSide(order.side as Side);
  } else if (event.eventName === 'OrderFilled' && signedOrder !== null) {
    side = oppositeSide(signedOrder.side as Side);
  }

  let amountRaw: string | null = null;
  for (const candidate of [
    'amountRaw',
    'fillSizeRaw',
    'sizeRaw',
    'value',
    'payout',
    'remainingSizeRaw',
    'activityMoneyInRaw',
    'makerAmountFilled',
    'takerAmountFilled',
  ]) {
    const value = args[candidate];
    if (typeof value === 'bigint') {
      amountRaw = value.toString();
      break;
    }
  }

  let priceRaw: string | null = null;
  if (typeof args.priceRawPerToken === 'bigint') {
    priceRaw = args.priceRawPerToken.toString();
  } else if (typeof args.frozenYesPriceRaw === 'bigint') {
    priceRaw = args.frozenYesPriceRaw.toString();
  } else if (
    event.eventName === 'OrderFilled' &&
    typeof args.fillSizeRaw === 'bigint' &&
    typeof args.paymentRaw === 'bigint'
  ) {
    priceRaw = averagePriceRaw(args.fillSizeRaw, args.paymentRaw);
  } else if (
    event.eventName === 'TradeExecuted' &&
    typeof args.amountRaw === 'bigint' &&
    (typeof args.side === 'bigint' || typeof args.side === 'number')
  ) {
    const notional =
      BigInt(args.side) === 0n
        ? bigintArg(args, 'totalCostRaw')
        : bigintArg(args, 'netProceedsRaw');
    priceRaw = averagePriceRaw(args.amountRaw, notional);
  }

  return {
    marketId: market?.id ?? null,
    account,
    outcome,
    side,
    amountRaw,
    priceRaw,
  };
}

async function insertActivityGuard(tx: Tx, event: DecodedEvent): Promise<boolean> {
  const context = await activityContext(tx, event);
  const result = await tx.activityEvent.createMany({
    data: [
      {
        id: eventId(event),
        type: ACTIVITY_TYPE[key(event)] ?? event.eventName,
        eventName: event.eventName,
        source: event.source,
        marketId: context.marketId,
        account: context.account,
        outcome: context.outcome,
        side: context.side,
        amountRaw: context.amountRaw,
        priceRaw: context.priceRaw,
        txHash: event.txHash,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber,
        ts: event.ts,
        data: jsonSafe(event.args) as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });
  return result.count === 1;
}

interface MarkPrices {
  yesPriceRaw: string;
  noPriceRaw: string;
}

async function currentMarkPrices(
  tx: Tx,
  marketId: string,
  fallback?: MarkPrices,
): Promise<MarkPrices> {
  const resolution = await tx.resolution.findUnique({ where: { marketId } });
  if (resolution !== null) {
    return {
      yesPriceRaw: (
        (BigInt(resolution.payoutYes) * PRICE_SCALE) /
        BigInt(resolution.denominator)
      ).toString(),
      noPriceRaw: (
        (BigInt(resolution.payoutNo) * PRICE_SCALE) /
        BigInt(resolution.denominator)
      ).toString(),
    };
  }
  if (fallback !== undefined) return fallback;
  const market = await marketById(tx, marketId);
  return {
    yesPriceRaw: market.yesPriceRaw,
    noPriceRaw: market.noPriceRaw,
  };
}

async function adjustAccountPnl(
  tx: Tx,
  account: string,
  realizedDelta: bigint,
  unrealizedDelta: bigint,
): Promise<void> {
  if (realizedDelta === 0n && unrealizedDelta === 0n) return;
  const updated = await tx.$executeRaw`
    UPDATE "Account"
    SET
      "realizedPnlRaw" = (
        ("realizedPnlRaw")::numeric + ${realizedDelta.toString()}::numeric
      )::text,
      "unrealizedPnlRaw" = (
        ("unrealizedPnlRaw")::numeric + ${unrealizedDelta.toString()}::numeric
      )::text
    WHERE "address" = ${account}
  `;
  if (updated !== 1) {
    throw new Error(`Cannot update PnL rollup for unknown account ${account}`);
  }
}

async function markPositionAtPrices(
  tx: Tx,
  account: string,
  marketId: string,
  outcome: Outcome,
  prices: MarkPrices,
): Promise<void> {
  const position = await tx.position.findUnique({
    where: { account_marketId_outcome: { account, marketId, outcome } },
  });
  if (position === null) return;

  const markPriceRaw = BigInt(
    outcome === 'YES' ? prices.yesPriceRaw : prices.noPriceRaw,
  );
  const markedValue = (BigInt(position.qtyRaw) * markPriceRaw) / PRICE_SCALE;
  const unrealized = markedValue - BigInt(position.costBasisRaw);
  const previous = BigInt(position.unrealizedPnlRaw);
  if (unrealized === previous) return;
  await tx.position.update({
    where: { account_marketId_outcome: { account, marketId, outcome } },
    data: { unrealizedPnlRaw: unrealized.toString() },
  });
  await adjustAccountPnl(tx, account, 0n, unrealized - previous);
}

async function markPosition(
  tx: Tx,
  account: string,
  marketId: string,
  outcome: Outcome,
): Promise<void> {
  await markPositionAtPrices(
    tx,
    account,
    marketId,
    outcome,
    await currentMarkPrices(tx, marketId),
  );
}

async function markMarketPositions(
  tx: Tx,
  marketId: string,
  fallback?: MarkPrices,
): Promise<void> {
  const prices = await currentMarkPrices(tx, marketId, fallback);
  await tx.$executeRaw`
    WITH recalculated AS MATERIALIZED (
      SELECT
        position."account",
        position."marketId",
        position."outcome",
        (position."unrealizedPnlRaw")::numeric AS previous,
        (
          div(
            (position."qtyRaw")::numeric *
              CASE
                WHEN position."outcome" = 'YES'
                  THEN ${prices.yesPriceRaw}::numeric
                ELSE ${prices.noPriceRaw}::numeric
              END,
            ${PRICE_SCALE.toString()}::numeric
          ) - (position."costBasisRaw")::numeric
        ) AS next
      FROM "Position" AS position
      WHERE position."marketId" = ${marketId}
    ),
    updated_positions AS (
      UPDATE "Position" AS position
      SET "unrealizedPnlRaw" = recalculated.next::text
      FROM recalculated
      WHERE
        position."account" = recalculated."account"
        AND position."marketId" = recalculated."marketId"
        AND position."outcome" = recalculated."outcome"
        AND recalculated.next <> recalculated.previous
      RETURNING position."account"
    ),
    deltas AS (
      SELECT
        recalculated."account",
        SUM(recalculated.next - recalculated.previous) AS delta
      FROM recalculated
      WHERE recalculated.next <> recalculated.previous
      GROUP BY recalculated."account"
    )
    UPDATE "Account" AS account
    SET "unrealizedPnlRaw" = (
      (account."unrealizedPnlRaw")::numeric + deltas.delta
    )::text
    FROM deltas
    WHERE account."address" = deltas."account"
  `;
}

async function adjustPosition(
  tx: Tx,
  account: string,
  marketId: string,
  outcome: Outcome,
  delta: bigint,
  event: Pick<DecodedEvent, 'blockNumber' | 'ts'>,
): Promise<void> {
  if (account === ZERO_ADDRESS) return;
  await ensureAccount(tx, account, event.ts);
  const selector = { account_marketId_outcome: { account, marketId, outcome } };
  const current = await tx.position.findUnique({ where: selector });
  // An absolute reconciliation snapshot already includes every transfer in
  // this block range. This matters for an operator replay of a recorded gap:
  // applying those formerly-missing deltas after the snapshot would double
  // count them and corrupt the repaired balance again.
  if (
    current?.balanceReconciledBlock !== null &&
    current?.balanceReconciledBlock !== undefined &&
    event.blockNumber <= current.balanceReconciledBlock
  ) {
    return;
  }
  const nextQty = BigInt(current?.qtyRaw ?? '0') + delta;
  if (nextQty < 0n) {
    throw new Error(
      `Negative authoritative position for ${account} market=${marketId} outcome=${outcome}`,
    );
  }
  await tx.position.upsert({
    where: selector,
    create: {
      account,
      marketId,
      outcome,
      qtyRaw: nextQty.toString(),
      updatedAt: event.ts,
    },
    update: {
      qtyRaw: nextQty.toString(),
      updatedAt: event.ts,
    },
  });
  await markPosition(tx, account, marketId, outcome);
}

async function addEstimatedBuyBasis(
  tx: Tx,
  account: string,
  marketId: string,
  outcome: Outcome,
  cost: bigint,
  ts: number,
): Promise<void> {
  await ensureAccount(tx, account, ts);
  const selector = { account_marketId_outcome: { account, marketId, outcome } };
  const position = await tx.position.findUnique({ where: selector });
  const nextBasis = BigInt(position?.costBasisRaw ?? '0') + cost;
  await tx.position.upsert({
    where: selector,
    create: {
      account,
      marketId,
      outcome,
      costBasisRaw: nextBasis.toString(),
      updatedAt: ts,
    },
    update: {
      costBasisRaw: nextBasis.toString(),
      updatedAt: ts,
    },
  });
  await markPosition(tx, account, marketId, outcome);
}

async function applyEstimatedSell(
  tx: Tx,
  account: string,
  marketId: string,
  outcome: Outcome,
  size: bigint,
  proceeds: bigint,
  ts: number,
): Promise<void> {
  await ensureAccount(tx, account, ts);
  const selector = { account_marketId_outcome: { account, marketId, outcome } };
  const position = await tx.position.findUnique({ where: selector });
  const basis = BigInt(position?.costBasisRaw ?? '0');
  // The CTF transfer generally precedes TradeExecuted, so restore the sold
  // amount to estimate the pre-trade holding used for pro-rata basis removal.
  const estimatedPreTradeQty = BigInt(position?.qtyRaw ?? '0') + size;
  const allocatedBasis =
    estimatedPreTradeQty > 0n
      ? (basis * (size < estimatedPreTradeQty ? size : estimatedPreTradeQty)) /
        estimatedPreTradeQty
      : 0n;
  const nextBasis = basis - allocatedBasis;
  const nextRealized =
    BigInt(position?.realizedPnlRaw ?? '0') + proceeds - allocatedBasis;
  const realizedDelta =
    nextRealized - BigInt(position?.realizedPnlRaw ?? '0');
  await tx.position.upsert({
    where: selector,
    create: {
      account,
      marketId,
      outcome,
      costBasisRaw: nextBasis.toString(),
      realizedPnlRaw: nextRealized.toString(),
      updatedAt: ts,
    },
    update: {
      costBasisRaw: nextBasis.toString(),
      realizedPnlRaw: nextRealized.toString(),
      updatedAt: ts,
    },
  });
  await adjustAccountPnl(tx, account, realizedDelta, 0n);
  await markPosition(tx, account, marketId, outcome);
}

async function recordMarketTrade(
  tx: Tx,
  marketId: string,
  account: string,
  volumeRaw: bigint,
  ts: number,
): Promise<void> {
  const market = await marketById(tx, marketId);
  await tx.market.update({
    where: { id: marketId },
    data: {
      tradeCount: { increment: 1 },
      volumeRaw: (BigInt(market.volumeRaw) + volumeRaw).toString(),
    },
  });
  await tx.account.upsert({
    where: { address: account },
    create: { address: account, firstSeenAt: ts, tradeCount: 1 },
    update: { tradeCount: { increment: 1 } },
  });
}

async function handleMarketCreated(tx: Tx, event: DecodedEvent): Promise<void> {
  const data = marketCreatedData(event);
  const config = await tx.registryConfig.findUnique({ where: { id: 1 } });
  await tx.market.update({
    where: { id: data.id },
    data: {
      seedFloorRaw: config?.seedFloorRaw ?? '0',
      seedCapRaw: config?.seedCapRaw ?? '0',
      fCapRaw: config?.fCapRaw ?? '0',
      graduationThresholdRaw: config?.graduationMoneyInThresholdRaw ?? '0',
      graduationTollRaw: config?.graduationTollRaw ?? '0',
      inventoryTargetRaw: config?.inventoryTargetRaw ?? '0',
      protocolFeeBps: config?.protocolFeeBps ?? 0,
      depthFeeBps: config?.depthFeeBps ?? 0,
      tradingWindowSeconds: config?.defaultTradingWindowSeconds ?? 0,
      minimumTimeOpenSeconds: config?.minimumTimeOpenSeconds ?? 0,
    },
  });
  await tx.account.upsert({
    where: { address: data.creator },
    create: {
      address: data.creator,
      firstSeenAt: data.createdAt,
      marketsCreated: 1,
    },
    update: { marketsCreated: { increment: 1 } },
  });
}

async function handleDefaultParams(tx: Tx, event: DecodedEvent): Promise<void> {
  const params = tupleArg(event.args, 'params');
  const marketTypeVersion = toDbInt(
    bigintArg(event.args, 'marketTypeVersion'),
    'marketTypeVersion',
  );
  const existing = await tx.registryConfig.findUniqueOrThrow({ where: { id: 1 } });
  if (
    !eventIsNewer(event, {
      blockNumber: existing.updatedBlock,
      logIndex: existing.updatedLogIndex,
    })
  ) {
    return;
  }
  await tx.registryConfig.update({
    where: { id: 1 },
    data: {
      marketTypeVersion,
      openingFeeRaw: tupleBigint(params, 'openingFeeRaw').toString(),
      seedFloorRaw: tupleBigint(params, 'seedFloorRaw').toString(),
      seedCapRaw: tupleBigint(params, 'seedCapRaw').toString(),
      fCapRaw: tupleBigint(params, 'fCapRaw').toString(),
      singleTopUpCapRaw: tupleBigint(params, 'singleTopUpCapRaw').toString(),
      graduationMoneyInThresholdRaw: tupleBigint(
        params,
        'graduationMoneyInThresholdRaw',
      ).toString(),
      graduationTollRaw: tupleBigint(params, 'graduationTollRaw').toString(),
      inventoryTargetRaw: tupleBigint(params, 'inventoryTargetRaw').toString(),
      inventoryLowRaw: tupleBigint(params, 'inventoryLowRaw').toString(),
      inventoryHighRaw: tupleBigint(params, 'inventoryHighRaw').toString(),
      freeCollateralBufferRaw: tupleBigint(params, 'freeCollateralBufferRaw').toString(),
      defaultTradingWindowSeconds: toDbInt(
        tupleBigint(params, 'tradingWindow'),
        'tradingWindow',
      ),
      minTradingWindowSeconds: toDbInt(
        tupleBigint(params, 'minTradingWindowSeconds'),
        'minTradingWindowSeconds',
      ),
      maxTradingWindowSeconds: toDbInt(
        tupleBigint(params, 'maxTradingWindowSeconds'),
        'maxTradingWindowSeconds',
      ),
      minimumTimeOpenSeconds: toDbInt(
        tupleBigint(params, 'minimumTimeOpen'),
        'minimumTimeOpen',
      ),
      protocolFeeBps: toDbInt(tupleBigint(params, 'protocolFeeBps'), 'protocolFeeBps'),
      depthFeeBps: toDbInt(tupleBigint(params, 'depthFeeBps'), 'depthFeeBps'),
      updatedBlock: event.blockNumber,
      updatedLogIndex: event.logIndex,
    },
  });
}

async function handleMarketParameterSnapshot(tx: Tx, event: DecodedEvent): Promise<void> {
  await tx.market.update({
    where: { id: bigintArg(event.args, 'marketId').toString() },
    data: {
      openingFeeRaw: bigintArg(event.args, 'openingFeeRaw').toString(),
      seedRaw: bigintArg(event.args, 'seedRaw').toString(),
      seedCapRaw: bigintArg(event.args, 'seedCapRaw').toString(),
      fCapRaw: bigintArg(event.args, 'fCapRaw').toString(),
      protocolFeeBps: toDbInt(bigintArg(event.args, 'protocolFeeBps'), 'protocolFeeBps'),
      depthFeeBps: toDbInt(bigintArg(event.args, 'depthFeeBps'), 'depthFeeBps'),
      graduationThresholdRaw: bigintArg(
        event.args,
        'graduationMoneyInActivityThresholdRaw',
      ).toString(),
      graduationTollRaw: bigintArg(event.args, 'graduationTollRaw').toString(),
      minimumTimeOpenSeconds: toDbInt(
        bigintArg(event.args, 'minimumTimeOpen'),
        'minimumTimeOpen',
      ),
      tradingWindowSeconds: toDbInt(
        bigintArg(event.args, 'tradingWindowSeconds'),
        'tradingWindowSeconds',
      ),
      tradingEndsAt: toDbInt(bigintArg(event.args, 'tradingEndsAt'), 'tradingEndsAt'),
    },
  });
}

async function handleTradeExecuted(tx: Tx, event: DecodedEvent): Promise<void> {
  const marketId = bigintArg(event.args, 'marketId').toString();
  const trader = lowerAddress(stringArg(event.args, 'trader'));
  const recipient = lowerAddress(stringArg(event.args, 'recipient'));
  const outcome = outcomeFromIndex(bigintArg(event.args, 'outcome'));
  const side = sideFromIndex(bigintArg(event.args, 'side'));
  const size = bigintArg(event.args, 'amountRaw');
  const baseAmount = bigintArg(event.args, 'baseAmountRaw');
  const protocolFee = bigintArg(event.args, 'protocolFeeRaw');
  const depthContribution = bigintArg(event.args, 'depthContributionRaw');
  const totalCost = bigintArg(event.args, 'totalCostRaw');
  const netProceeds = bigintArg(event.args, 'netProceedsRaw');
  const cost = side === 'BID' ? totalCost : netProceeds;
  const fee = protocolFee + depthContribution;

  await tx.trade.create({
    data: {
      id: eventId(event),
      marketId,
      venue: 'LMSR',
      account: trader,
      recipient,
      outcome,
      side,
      sizeRaw: size.toString(),
      priceRaw: averagePriceRaw(size, cost),
      costRaw: cost.toString(),
      feeRaw: fee.toString(),
      baseAmountRaw: baseAmount.toString(),
      protocolFeeRaw: protocolFee.toString(),
      depthContributionRaw: depthContribution.toString(),
      totalCostRaw: totalCost.toString(),
      netProceedsRaw: netProceeds.toString(),
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      ts: event.ts,
    },
  });
  await recordMarketTrade(tx, marketId, trader, baseAmount, event.ts);

  if (side === 'BID') {
    await addEstimatedBuyBasis(tx, recipient, marketId, outcome, totalCost, event.ts);
  } else {
    await applyEstimatedSell(tx, trader, marketId, outcome, size, netProceeds, event.ts);
  }
}

async function handleTradeState(tx: Tx, event: DecodedEvent): Promise<void> {
  const marketId = bigintArg(event.args, 'marketId').toString();
  const qYes = bigintArg(event.args, 'qYesRawAfter');
  const qNo = bigintArg(event.args, 'qNoRawAfter');
  const bCurrentWad = bigintArg(event.args, 'bCurrentWadAfter');
  const prices = marginalPricesRaw(qYes, qNo, bCurrentWad);
  await tx.market.update({
    where: { id: marketId },
    data: {
      ...prices,
      qYesRaw: qYes.toString(),
      qNoRaw: qNo.toString(),
      fundingCommittedRaw: bigintArg(event.args, 'FCommittedRawAfter').toString(),
      bCurrentWad: bCurrentWad.toString(),
      inventoryYesRaw: bigintArg(event.args, 'inventoryYesRawAfter').toString(),
      inventoryNoRaw: bigintArg(event.args, 'inventoryNoRawAfter').toString(),
      lastSplitAmountRaw: bigintArg(event.args, 'splitAmountRaw').toString(),
      lastMergeAmountRaw: bigintArg(event.args, 'mergeAmountRaw').toString(),
      graduationActivityRaw: bigintArg(
        event.args,
        'graduationMoneyInRawAfter',
      ).toString(),
    },
  });
  await tx.pricePoint.create({
    data: {
      id: eventId(event),
      marketId,
      ...prices,
      qYesRaw: qYes.toString(),
      qNoRaw: qNo.toString(),
      bCurrentWad: bCurrentWad.toString(),
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      ts: event.ts,
    },
  });
  await markMarketPositions(tx, marketId, prices);
}

async function handleGraduation(tx: Tx, event: DecodedEvent): Promise<void> {
  const marketId = bigintArg(event.args, 'marketId').toString();
  await advancePhase(tx, marketId, 'Graduated');
  await tx.market.update({
    where: { id: marketId },
    data: {
      graduatedAt: toDbInt(bigintArg(event.args, 'graduatedAt'), 'graduatedAt'),
      graduationActivityRaw: bigintArg(event.args, 'activityMoneyInRaw').toString(),
      graduationThresholdRaw: bigintArg(event.args, 'activityThresholdRaw').toString(),
      graduationTollRaw: bigintArg(event.args, 'graduationTollRaw').toString(),
      minimumTimeOpenSeconds: toDbInt(
        bigintArg(event.args, 'minimumTimeOpen'),
        'minimumTimeOpen',
      ),
    },
  });
}

async function markSeedOrders(
  tx: Tx,
  marketId: string,
  yesOrderId: string,
  noOrderId: string,
): Promise<void> {
  await tx.order.updateMany({
    where: { orderId: { in: [yesOrderId, noOrderId] } },
    data: { isSeed: true },
  });
  await tx.market.update({
    where: { id: marketId },
    data: { yesSeedOrderId: yesOrderId, noSeedOrderId: noOrderId },
  });
}

async function handleRegistryBookSeeded(tx: Tx, event: DecodedEvent): Promise<void> {
  const marketId = bigintArg(event.args, 'marketId').toString();
  const yesOrderId = bigintArg(event.args, 'yesOrderId').toString();
  const noOrderId = bigintArg(event.args, 'noOrderId').toString();
  const frozenYesPrice = bigintArg(event.args, 'frozenYesPriceRaw');
  await tx.market.update({
    where: { id: marketId },
    data: {
      bookAddress: lowerAddress(stringArg(event.args, 'miniClob')),
      handoffSizeRaw: bigintArg(event.args, 'sizeRaw').toString(),
      frozenYesPriceRaw: frozenYesPrice.toString(),
      yesPriceRaw: frozenYesPrice.toString(),
      noPriceRaw: (PRICE_SCALE - frozenYesPrice).toString(),
    },
  });
  await markSeedOrders(tx, marketId, yesOrderId, noOrderId);
  await tx.bookMigration.upsert({
    where: { marketId },
    create: {
      marketId,
      yesSeedOrderId: yesOrderId,
      noSeedOrderId: noOrderId,
      createdAt: event.ts,
      updatedAt: event.ts,
    },
    update: {},
  });
}

async function handleGraduationSeeded(tx: Tx, event: DecodedEvent): Promise<void> {
  const market = await marketByCondition(
    tx,
    stringArg(event.args, 'conditionId').toLowerCase(),
  );
  const yesOrderId = bigintArg(event.args, 'yesOrderId').toString();
  const noOrderId = bigintArg(event.args, 'noOrderId').toString();
  const frozenYesPrice = bigintArg(event.args, 'frozenYesPriceRaw');
  await tx.market.update({
    where: { id: market.id },
    data: {
      bookAddress: lowerAddress(ADDRESSES.miniClob),
      handoffSizeRaw: bigintArg(event.args, 'sizeRaw').toString(),
      frozenYesPriceRaw: frozenYesPrice.toString(),
      yesPriceRaw: frozenYesPrice.toString(),
      noPriceRaw: (PRICE_SCALE - frozenYesPrice).toString(),
    },
  });
  await markSeedOrders(tx, market.id, yesOrderId, noOrderId);
}

async function handleConditionCutover(tx: Tx, event: DecodedEvent): Promise<void> {
  const market = await marketByCondition(
    tx,
    stringArg(event.args, 'conditionId').toLowerCase(),
  );
  const yesOrderId = bigintArg(event.args, 'yesSeedOrderId').toString();
  const noOrderId = bigintArg(event.args, 'noSeedOrderId').toString();
  if (
    (market.yesSeedOrderId !== null && market.yesSeedOrderId !== yesOrderId) ||
    (market.noSeedOrderId !== null && market.noSeedOrderId !== noOrderId)
  ) {
    throw new Error(`Cutover seed ids conflict with market ${market.id}`);
  }
  await markSeedOrders(tx, market.id, yesOrderId, noOrderId);
  await tx.bookMigration.upsert({
    where: { marketId: market.id },
    create: {
      marketId: market.id,
      yesSeedOrderId: yesOrderId,
      noSeedOrderId: noOrderId,
      cutoverTxHash: event.txHash.toLowerCase(),
      createdAt: event.ts,
      updatedAt: event.ts,
    },
    // A cutover event proves only that MiniCLOB is stale. The operator must
    // still snapshot, approve, register, and publish before Hybrid is live.
    update: {},
  });
}

async function handleOrderPlaced(tx: Tx, event: DecodedEvent): Promise<void> {
  const conditionId = stringArg(event.args, 'conditionId').toLowerCase();
  const market = await marketByCondition(tx, conditionId);
  const tokenId = bigintArg(event.args, 'tokenId').toString();
  const outcome =
    market.yesTokenId === tokenId
      ? 'YES'
      : market.noTokenId === tokenId
        ? 'NO'
        : null;
  if (outcome === null) {
    throw new Error(`Order token ${tokenId} is not bound to market ${market.id}`);
  }
  const orderId = bigintArg(event.args, 'orderId').toString();
  const maker = lowerAddress(stringArg(event.args, 'maker'));
  const sizeRaw = bigintArg(event.args, 'sizeRaw').toString();
  await tx.order.upsert({
    where: { orderId },
    create: {
      orderId,
      marketId: market.id,
      conditionId,
      tokenId,
      outcome,
      maker,
      side: sideFromIndex(bigintArg(event.args, 'side')),
      priceRaw: bigintArg(event.args, 'priceRawPerToken').toString(),
      sizeRaw,
      escrowRaw: bigintArg(event.args, 'escrowRaw').toString(),
      remainingRaw: sizeRaw,
      isSeed: market.yesSeedOrderId === orderId || market.noSeedOrderId === orderId,
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      createdAt: event.ts,
      updatedAt: event.ts,
    },
    update: {},
  });
  await ensureAccount(tx, maker, event.ts);
}

async function handleOrderFilled(tx: Tx, event: DecodedEvent): Promise<void> {
  const orderId = bigintArg(event.args, 'orderId').toString();
  const order = await tx.order.findUnique({ where: { orderId } });
  if (order === null) {
    throw new Error(`Fill refers to unknown orderId ${orderId}`);
  }
  const maker = lowerAddress(stringArg(event.args, 'maker'));
  const taker = lowerAddress(stringArg(event.args, 'taker'));
  const fillSize = bigintArg(event.args, 'fillSizeRaw');
  const payment = bigintArg(event.args, 'paymentRaw');
  const filledAfter = bigintArg(event.args, 'filledRawAfter');
  const openAfter = booleanArg(event.args, 'openAfter');
  const remaining = BigInt(order.sizeRaw) - filledAfter;
  if (remaining < 0n) {
    throw new Error(`Order ${orderId} filled amount exceeds its size`);
  }

  await tx.fill.create({
    data: {
      id: eventId(event),
      orderId,
      marketId: order.marketId,
      taker,
      maker,
      outcome: order.outcome,
      fillSizeRaw: fillSize.toString(),
      paymentRaw: payment.toString(),
      filledAfterRaw: filledAfter.toString(),
      openAfter,
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      ts: event.ts,
    },
  });
  await tx.order.update({
    where: { orderId },
    data: {
      filledRaw: filledAfter.toString(),
      remainingRaw: remaining.toString(),
      open: openAfter,
      updatedAt: event.ts,
    },
  });

  const makerSide = order.side as Side;
  const takerSide = oppositeSide(makerSide);
  await tx.trade.create({
    data: {
      id: eventId(event),
      marketId: order.marketId,
      venue: 'BOOK',
      account: taker,
      recipient: takerSide === 'BID' ? taker : maker,
      outcome: order.outcome,
      side: takerSide,
      sizeRaw: fillSize.toString(),
      priceRaw: averagePriceRaw(fillSize, payment),
      costRaw: payment.toString(),
      feeRaw: '0',
      baseAmountRaw: payment.toString(),
      protocolFeeRaw: '0',
      depthContributionRaw: '0',
      totalCostRaw: takerSide === 'BID' ? payment.toString() : '0',
      netProceedsRaw: takerSide === 'ASK' ? payment.toString() : '0',
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      ts: event.ts,
    },
  });
  await recordMarketTrade(tx, order.marketId, taker, payment, event.ts);

  const outcome = order.outcome as Outcome;
  if (makerSide === 'ASK') {
    await addEstimatedBuyBasis(tx, taker, order.marketId, outcome, payment, event.ts);
    await applyEstimatedSell(tx, maker, order.marketId, outcome, fillSize, payment, event.ts);
  } else {
    await addEstimatedBuyBasis(tx, maker, order.marketId, outcome, payment, event.ts);
    await applyEstimatedSell(tx, taker, order.marketId, outcome, fillSize, payment, event.ts);
  }
}

async function handleOrderCancelled(tx: Tx, event: DecodedEvent): Promise<void> {
  const orderId = bigintArg(event.args, 'orderId').toString();
  const result = await tx.order.updateMany({
    where: { orderId },
    data: {
      remainingRaw: bigintArg(event.args, 'remainingSizeRaw').toString(),
      open: false,
      updatedAt: event.ts,
    },
  });
  if (result.count !== 1) {
    throw new Error(`Cancellation refers to unknown orderId ${orderId}`);
  }
}

function eventIsNewer(
  event: DecodedEvent,
  existing: { blockNumber: number; logIndex: number },
): boolean {
  return (
    event.blockNumber > existing.blockNumber ||
    (event.blockNumber === existing.blockNumber && event.logIndex > existing.logIndex)
  );
}

async function handleCtfExchangeApproval(
  tx: Tx,
  event: DecodedEvent,
): Promise<void> {
  const owner = lowerAddress(stringArg(event.args, 'account'));
  const existing = await tx.ctfExchangeApproval.findUnique({ where: { owner } });
  if (existing !== null && !eventIsNewer(event, existing)) return;
  await tx.ctfExchangeApproval.upsert({
    where: { owner },
    create: {
      owner,
      approved: booleanArg(event.args, 'approved'),
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      updatedAt: event.ts,
    },
    update: {
      approved: booleanArg(event.args, 'approved'),
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      updatedAt: event.ts,
    },
  });
}

async function handleCollateralApproval(
  tx: Tx,
  event: DecodedEvent,
): Promise<void> {
  const owner = lowerAddress(stringArg(event.args, 'owner'));
  const existing = await tx.collateralExchangeApproval.findUnique({
    where: { owner },
  });
  if (existing !== null && !eventIsNewer(event, existing)) return;
  const allowanceRaw = bigintArg(event.args, 'value').toString();
  await tx.collateralExchangeApproval.upsert({
    where: { owner },
    create: {
      owner,
      allowanceRaw,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      updatedAt: event.ts,
    },
    update: {
      allowanceRaw,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      updatedAt: event.ts,
    },
  });
}

async function applyCollateralDelta(
  tx: Tx,
  event: DecodedEvent,
  owner: string,
  delta: bigint,
): Promise<void> {
  if (owner === ZERO_ADDRESS) return;
  const existing = await tx.collateralBalance.findUnique({ where: { owner } });
  // Only makers snapshotted during BUY-order ingest are tracked.
  if (existing === null || !eventIsNewer(event, existing)) return;
  const next = BigInt(existing.balanceRaw) + delta;
  if (next < 0n) {
    throw new Error(`Collateral balance delta underflow for tracked maker ${owner}`);
  }
  await tx.collateralBalance.update({
    where: { owner },
    data: {
      balanceRaw: next.toString(),
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      updatedAt: event.ts,
    },
  });
}

async function handleCollateralTransfer(
  tx: Tx,
  event: DecodedEvent,
): Promise<void> {
  const from = lowerAddress(stringArg(event.args, 'from'));
  const to = lowerAddress(stringArg(event.args, 'to'));
  if (from === to) return;
  const value = bigintArg(event.args, 'value');
  await applyCollateralDelta(tx, event, from, -value);
  await applyCollateralDelta(tx, event, to, value);
}

async function handleExchangeTokenRegistered(
  tx: Tx,
  event: DecodedEvent,
): Promise<void> {
  const tokenId = bigintArg(event.args, 'tokenId').toString();
  await tx.exchangeTokenRegistration.upsert({
    where: { tokenId },
    create: {
      tokenId,
      complementTokenId: bigintArg(event.args, 'complement').toString(),
      conditionId: stringArg(event.args, 'conditionId').toLowerCase(),
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      registeredAt: event.ts,
    },
    update: {
      complementTokenId: bigintArg(event.args, 'complement').toString(),
      conditionId: stringArg(event.args, 'conditionId').toLowerCase(),
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
    },
  });
}

async function handleExchangeOrderFilled(
  tx: Tx,
  event: DecodedEvent,
): Promise<void> {
  const orderHash = stringArg(event.args, 'orderHash').toLowerCase();
  const order = await tx.signedOrder.findUnique({ where: { orderHash } });
  if (order === null) return;
  const fillSize =
    order.exchangeSide === 0
      ? bigintArg(event.args, 'takerAmountFilled')
      : bigintArg(event.args, 'makerAmountFilled');
  const filled = BigInt(order.filledRaw) + fillSize;
  const size = BigInt(order.sizeRaw);
  if (filled > size) {
    throw new Error(`Exchange fill exceeds signed order size for ${orderHash}`);
  }
  const remaining = size - filled;
  const status =
    remaining === 0n
      ? 'FILLED'
      : order.withdrawnAt === null
        ? 'PARTIALLY_FILLED'
        : order.status;
  await tx.signedOrder.update({
    where: { orderHash },
    data: {
      filledRaw: filled.toString(),
      remainingRaw: remaining.toString(),
      status,
      lastOnchainTxHash: event.txHash,
      lastOnchainBlock: event.blockNumber,
      updatedAt: event.ts,
    },
  });
  await tx.settlementMatch.updateMany({
    where: { txHash: event.txHash.toLowerCase(), status: 'SUBMITTED' },
    data: { status: 'CONFIRMED', updatedAt: event.ts },
  });
}

async function handleExchangeOrderCancelled(
  tx: Tx,
  event: DecodedEvent,
): Promise<void> {
  const orderHash = stringArg(event.args, 'orderHash').toLowerCase();
  await tx.signedOrder.updateMany({
    where: { orderHash, status: { not: 'FILLED' } },
    data: {
      status: 'CANCELLED',
      lastOnchainTxHash: event.txHash,
      lastOnchainBlock: event.blockNumber,
      updatedAt: event.ts,
    },
  });
}

async function handleAllExchangeOrdersCancelled(
  tx: Tx,
  event: DecodedEvent,
): Promise<void> {
  const maker = lowerAddress(stringArg(event.args, 'maker'));
  const newNonce = bigintArg(event.args, 'newNonce');
  const candidates = await tx.signedOrder.findMany({
    where: {
      maker,
      status: { in: ['OPEN', 'PARTIALLY_FILLED', 'WITHDRAWN'] },
    },
    select: { orderHash: true, nonceRaw: true },
  });
  const invalidated = candidates
    .filter((order) => BigInt(order.nonceRaw) !== newNonce)
    .map((order) => order.orderHash);
  if (invalidated.length === 0) return;
  await tx.signedOrder.updateMany({
    where: { orderHash: { in: invalidated } },
    data: {
      status: 'NONCE_INVALIDATED',
      lastOnchainTxHash: event.txHash,
      lastOnchainBlock: event.blockNumber,
      updatedAt: event.ts,
    },
  });
}

async function handleTransfer(
  tx: Tx,
  from: string,
  to: string,
  tokenId: bigint,
  value: bigint,
  event: Pick<DecodedEvent, 'blockNumber' | 'ts'>,
): Promise<void> {
  const binding = await marketForToken(tx, tokenId.toString());
  if (binding === null) return;
  await adjustPosition(tx, from, binding.market.id, binding.outcome, -value, event);
  await adjustPosition(tx, to, binding.market.id, binding.outcome, value, event);
}

async function handleTransferSingle(tx: Tx, event: DecodedEvent): Promise<void> {
  await handleTransfer(
    tx,
    lowerAddress(stringArg(event.args, 'from')),
    lowerAddress(stringArg(event.args, 'to')),
    bigintArg(event.args, 'id'),
    bigintArg(event.args, 'value'),
    event,
  );
}

async function handleTransferBatch(tx: Tx, event: DecodedEvent): Promise<void> {
  const ids = bigintArrayArg(event.args, 'ids');
  const values = bigintArrayArg(event.args, 'values');
  if (ids.length !== values.length) {
    throw new Error(`TransferBatch ids/values length mismatch in ${eventId(event)}`);
  }
  const from = lowerAddress(stringArg(event.args, 'from'));
  const to = lowerAddress(stringArg(event.args, 'to'));
  for (let index = 0; index < ids.length; index += 1) {
    const tokenId = ids[index];
    const value = values[index];
    if (tokenId === undefined || value === undefined) {
      throw new Error(`Missing TransferBatch entry ${index}`);
    }
    await handleTransfer(tx, from, to, tokenId, value, event);
  }
}

async function persistResolution(
  tx: Tx,
  event: DecodedEvent,
  market: Market,
  payouts: readonly bigint[],
): Promise<void> {
  const resolution = deriveResolution(payouts);
  await tx.resolution.upsert({
    where: { marketId: market.id },
    create: {
      marketId: market.id,
      conditionId: market.conditionId,
      ...resolution,
      resolvedAt: event.ts,
      txHash: event.txHash,
      logIndex: event.logIndex,
    },
    update: {
      ...resolution,
      txHash: event.txHash,
      logIndex: event.logIndex,
    },
  });
  await tx.market.update({
    where: { id: market.id },
    data: { resolvedAt: market.resolvedAt ?? event.ts },
  });
  await tx.signedOrder.updateMany({
    where: {
      marketId: market.id,
      status: { in: ['OPEN', 'PARTIALLY_FILLED', 'WITHDRAWN'] },
    },
    data: {
      status: 'MARKET_RESOLVED',
      lastOnchainTxHash: event.txHash,
      lastOnchainBlock: event.blockNumber,
      updatedAt: event.ts,
    },
  });
  await markMarketPositions(tx, market.id);
}

async function handleQuestionResolved(tx: Tx, event: DecodedEvent): Promise<void> {
  // The configured adapter also accepts publicly initialized, non-Registry questions.
  const market = await tx.market.findFirst({
    where: { questionId: stringArg(event.args, 'questionId').toLowerCase() },
  });
  if (market === null) return;
  await persistResolution(tx, event, market, bigintArrayArg(event.args, 'payouts'));
}

async function handleConditionResolution(tx: Tx, event: DecodedEvent): Promise<void> {
  // ConditionalTokens is shared and can resolve conditions outside Predex markets.
  const market = await tx.market.findUnique({
    where: { conditionId: stringArg(event.args, 'conditionId').toLowerCase() },
  });
  if (market === null) return;
  await persistResolution(
    tx,
    event,
    market,
    bigintArrayArg(event.args, 'payoutNumerators'),
  );
}

async function handleLmsrResolutionObserved(tx: Tx, event: DecodedEvent): Promise<void> {
  const market = await marketById(tx, bigintArg(event.args, 'marketId').toString());
  await persistResolution(tx, event, market, [
    bigintArg(event.args, 'payoutYes'),
    bigintArg(event.args, 'payoutNo'),
  ]);
  const observedAt = toDbInt(bigintArg(event.args, 'observedAt'), 'observedAt');
  await tx.resolution.update({
    where: { marketId: market.id },
    data: { observedAt },
  });
  await advancePhase(tx, market.id, 'ResolvedObserved');
}

async function handleRegistryResolutionObserved(tx: Tx, event: DecodedEvent): Promise<void> {
  const marketId = bigintArg(event.args, 'marketId').toString();
  const observedAt = toDbInt(bigintArg(event.args, 'observedAt'), 'observedAt');
  const result = await tx.resolution.updateMany({
    where: { marketId },
    data: { observedAt },
  });
  if (result.count !== 1) {
    throw new Error(`Registry observed resolution before payout data for market ${marketId}`);
  }
  await advancePhase(tx, marketId, 'ResolvedObserved');
}

async function handleMarketCloseout(tx: Tx, event: DecodedEvent): Promise<void> {
  const marketId = bigintArg(event.args, 'marketId').toString();
  const closedOutAt = toDbInt(bigintArg(event.args, 'closedOutAt'), 'closedOutAt');
  await tx.closeout.upsert({
    where: { marketId },
    create: {
      marketId,
      conditionId: stringArg(event.args, 'conditionId').toLowerCase(),
      payoutYes: bigintArg(event.args, 'payoutYes').toString(),
      payoutNo: bigintArg(event.args, 'payoutNo').toString(),
      userTerminalClaimRaw: bigintArg(event.args, 'userTerminalClaimRaw').toString(),
      netBaseTradeCollectedRaw: bigintArg(
        event.args,
        'netBaseTradeCollectedRaw',
      ).toString(),
      fundingLossRaw: bigintArg(event.args, 'fundingLossRaw').toString(),
      fundingResidualRaw: bigintArg(event.args, 'fundingResidualRaw').toString(),
      protocolPnlRaw: bigintArg(event.args, 'protocolPnlRaw').toString(),
      protocolFeesRaw: bigintArg(event.args, 'protocolFeesRaw').toString(),
      redeemedYesRaw: bigintArg(event.args, 'redeemedYesRaw').toString(),
      redeemedNoRaw: bigintArg(event.args, 'redeemedNoRaw').toString(),
      closedOutAt,
      txHash: event.txHash,
      logIndex: event.logIndex,
    },
    update: {},
  });
  await advancePhase(tx, marketId, 'ClosedOut');
  await tx.market.update({ where: { id: marketId }, data: { closedOutAt } });
}

async function handleRegistryClosedOut(tx: Tx, event: DecodedEvent): Promise<void> {
  const marketId = bigintArg(event.args, 'marketId').toString();
  await advancePhase(tx, marketId, 'ClosedOut');
  await tx.market.update({
    where: { id: marketId },
    data: { closedOutAt: toDbInt(bigintArg(event.args, 'closedOutAt'), 'closedOutAt') },
  });
}

async function handleMarketTypeRegistered(tx: Tx, event: DecodedEvent): Promise<void> {
  const version = toDbInt(bigintArg(event.args, 'version'), 'marketTypeVersion');
  const lmsrAddress = lowerAddress(stringArg(event.args, 'lmsr'));
  const existingType = await tx.registeredMarketType.findUnique({ where: { version } });
  if (
    existingType !== null &&
    !eventIsNewer(event, {
      blockNumber: existingType.blockNumber,
      logIndex: existingType.logIndex,
    })
  ) {
    return;
  }
  await tx.registeredMarketType.upsert({
    where: { version },
    create: {
      version,
      lmsrAddress,
      configHash: stringArg(event.args, 'configHash').toLowerCase(),
      registeredAt: event.ts,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
    },
    update: {
      lmsrAddress,
      configHash: stringArg(event.args, 'configHash').toLowerCase(),
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
    },
  });
  const config = await tx.registryConfig.findUniqueOrThrow({ where: { id: 1 } });
  if (
    version >= config.marketTypeVersion &&
    eventIsNewer(event, {
      blockNumber: config.updatedBlock,
      logIndex: config.updatedLogIndex,
    })
  ) {
    await tx.registryConfig.update({
      where: { id: 1 },
      data: {
        marketTypeVersion: version,
        currentLmsrAddress: lmsrAddress,
        updatedBlock: event.blockNumber,
        updatedLogIndex: event.logIndex,
      },
    });
  }
}

async function handleCommitteeAdded(tx: Tx, event: DecodedEvent): Promise<void> {
  const address = lowerAddress(stringArg(event.args, 'signer'));
  const existing = await tx.committeeMember.findUnique({ where: { address } });
  if (
    existing !== null &&
    !eventIsNewer(event, {
      blockNumber: existing.updatedBlock,
      logIndex: existing.updatedLogIndex,
    })
  ) {
    return;
  }
  await tx.committeeMember.upsert({
    where: { address },
    create: {
      address,
      active: true,
      addedAt: event.ts,
      updatedBlock: event.blockNumber,
      updatedLogIndex: event.logIndex,
    },
    update: {
      active: true,
      removedAt: null,
      updatedBlock: event.blockNumber,
      updatedLogIndex: event.logIndex,
    },
  });
}

async function handleCommitteeRemoved(tx: Tx, event: DecodedEvent): Promise<void> {
  const address = lowerAddress(stringArg(event.args, 'signer'));
  const existing = await tx.committeeMember.findUnique({ where: { address } });
  if (
    existing !== null &&
    !eventIsNewer(event, {
      blockNumber: existing.updatedBlock,
      logIndex: existing.updatedLogIndex,
    })
  ) {
    return;
  }
  await tx.committeeMember.upsert({
    where: { address },
    create: {
      address,
      active: false,
      addedAt: event.ts,
      removedAt: event.ts,
      updatedBlock: event.blockNumber,
      updatedLogIndex: event.logIndex,
    },
    update: {
      active: false,
      removedAt: event.ts,
      updatedBlock: event.blockNumber,
      updatedLogIndex: event.logIndex,
    },
  });
}

async function handleThresholdChanged(tx: Tx, event: DecodedEvent): Promise<void> {
  const existing = await tx.registryConfig.findUniqueOrThrow({ where: { id: 1 } });
  if (
    !eventIsNewer(event, {
      blockNumber: existing.updatedBlock,
      logIndex: existing.updatedLogIndex,
    })
  ) {
    return;
  }
  await tx.registryConfig.update({
    where: { id: 1 },
    data: {
      committeeThreshold: toDbInt(
        bigintArg(event.args, 'newThreshold'),
        'committeeThreshold',
      ),
      updatedBlock: event.blockNumber,
      updatedLogIndex: event.logIndex,
    },
  });
}

export async function initializeReadModel(tx: Tx, deployBlock: number): Promise<void> {
  const addresses = {
    usdc: lowerAddress(ADDRESSES.usdc),
    ctf: lowerAddress(ADDRESSES.ctf),
    oracle: lowerAddress(ADDRESSES.oracle),
    lmsr: lowerAddress(ADDRESSES.lmsr),
    registry: lowerAddress(ADDRESSES.registry),
    miniClob: lowerAddress(ADDRESSES.miniClob),
  };

  const existingConfig = await tx.registryConfig.findUnique({ where: { id: 1 } });
  if (
    existingConfig !== null &&
    (existingConfig.chainId !== ARC.chainId ||
      existingConfig.registryAddress !== addresses.registry)
  ) {
    throw new Error(
      `Database belongs to chain=${existingConfig.chainId} registry=${existingConfig.registryAddress}; ` +
        `expected chain=${ARC.chainId} registry=${addresses.registry}`,
    );
  }

  await tx.registryConfig.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      chainId: ARC.chainId,
      usdcAddress: addresses.usdc,
      ctfAddress: addresses.ctf,
      oracleAddress: addresses.oracle,
      lmsrAddress: addresses.lmsr,
      registryAddress: addresses.registry,
      miniClobAddress: addresses.miniClob,
      currentLmsrAddress: addresses.lmsr,
      updatedBlock: deployBlock - 1,
    },
    update: {},
  });

  const state = await tx.indexerState.findUnique({ where: { id: 1 } });
  if (
    state !== null &&
    (state.chainId !== ARC.chainId || state.deployBlock !== deployBlock)
  ) {
    throw new Error(
      `Indexer cursor belongs to chain=${state.chainId} deployBlock=${state.deployBlock}; ` +
        `expected chain=${ARC.chainId} deployBlock=${deployBlock}`,
    );
  }
  await tx.indexerState.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      chainId: ARC.chainId,
      deployBlock,
      lastBlock: deployBlock - 1,
    },
    update: {},
  });
  await tx.indexerSubscriptionState.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
}

export async function handleDecodedEvent(tx: Tx, event: DecodedEvent): Promise<boolean> {
  if (
    key(event) === 'CTF.ApprovalForAll' &&
    lowerAddress(stringArg(event.args, 'operator')) !==
      lowerAddress(ADDRESSES.ctfExchange)
  ) {
    return false;
  }
  if (
    key(event) === 'COLLATERAL.Approval' &&
    lowerAddress(stringArg(event.args, 'spender')) !==
      lowerAddress(ADDRESSES.ctfExchange)
  ) {
    return false;
  }
  const inserted = await insertActivityGuard(tx, event);
  if (!inserted) return false;

  switch (key(event)) {
    case 'REGISTRY.DefaultParamsUpdated':
      await handleDefaultParams(tx, event);
      break;
    case 'REGISTRY.MarketTypeVersionRegistered':
      await handleMarketTypeRegistered(tx, event);
      break;
    case 'REGISTRY.MarketCreated':
      await handleMarketCreated(tx, event);
      break;
    case 'REGISTRY.MarketParameterSnapshot':
      await handleMarketParameterSnapshot(tx, event);
      break;
    case 'REGISTRY.MarketTokenBinding':
    case 'REGISTRY.MarketGraduationBinding':
      // Identity data was applied in the pre-discovery pass.
      break;
    case 'REGISTRY.MarketGraduated':
      await handleGraduation(tx, event);
      break;
    case 'REGISTRY.MarketGraduationBookSeeded':
      await handleRegistryBookSeeded(tx, event);
      break;
    case 'REGISTRY.MarketResolutionObserved':
      await handleRegistryResolutionObserved(tx, event);
      break;
    case 'REGISTRY.MarketClosedOut':
      await handleRegistryClosedOut(tx, event);
      break;
    case 'LMSR.TradeExecuted':
      await handleTradeExecuted(tx, event);
      break;
    case 'LMSR.TradeState':
      await handleTradeState(tx, event);
      break;
    case 'LMSR.ResolutionObserved':
      await handleLmsrResolutionObserved(tx, event);
      break;
    case 'LMSR.MarketCloseout':
      await handleMarketCloseout(tx, event);
      break;
    case 'MINI_CLOB.GraduationSeeded':
      await handleGraduationSeeded(tx, event);
      break;
    case 'MINI_CLOB.ConditionCutover':
      await handleConditionCutover(tx, event);
      break;
    case 'MINI_CLOB.OrderPlaced':
      await handleOrderPlaced(tx, event);
      break;
    case 'MINI_CLOB.OrderFilled':
      await handleOrderFilled(tx, event);
      break;
    case 'MINI_CLOB.OrderCancelled':
      await handleOrderCancelled(tx, event);
      break;
    case 'CTF.TransferSingle':
      await handleTransferSingle(tx, event);
      break;
    case 'CTF.TransferBatch':
      await handleTransferBatch(tx, event);
      break;
    case 'CTF.ApprovalForAll':
      await handleCtfExchangeApproval(tx, event);
      break;
    case 'CTF.ConditionResolution':
      await handleConditionResolution(tx, event);
      break;
    case 'COLLATERAL.Approval':
      await handleCollateralApproval(tx, event);
      break;
    case 'COLLATERAL.Transfer':
      await handleCollateralTransfer(tx, event);
      break;
    case 'CTF_EXCHANGE.TokenRegistered':
      await handleExchangeTokenRegistered(tx, event);
      break;
    case 'CTF_EXCHANGE.OrderFilled':
      await handleExchangeOrderFilled(tx, event);
      break;
    case 'CTF_EXCHANGE.OrderCancelled':
      await handleExchangeOrderCancelled(tx, event);
      break;
    case 'CTF_EXCHANGE.AllOrdersCancelled':
      await handleAllExchangeOrdersCancelled(tx, event);
      break;
    case 'ORACLE.QuestionResolved':
      await handleQuestionResolved(tx, event);
      break;
    case 'ORACLE.CurrentMemberAdded':
      await handleCommitteeAdded(tx, event);
      break;
    case 'ORACLE.CurrentMemberRemoved':
      await handleCommitteeRemoved(tx, event);
      break;
    case 'ORACLE.ThresholdChanged':
      await handleThresholdChanged(tx, event);
      break;
    // PayoutRedemption and all other ABI events remain fully represented in
    // ActivityEvent. TransferSingle/Batch are the authoritative position delta.
    default:
      break;
  }
  return true;
}
