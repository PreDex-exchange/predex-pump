import type { Prisma, PrismaClient, SignedOrder } from '@prisma/client';
import {
  assertAllowedMinimumTickSizeRaw,
  isOrderSizeGranular,
  isPriceOnTick,
  OFFCHAIN_WITHDRAWAL_WARNING,
  type IngestOrderRequest,
  type IngestOrderResponse,
  type MakerOrdersResponse,
  type WithdrawOrderResponse,
} from '@predex-pump/shared';
import {
  CTF_EXCHANGE_PRICE_SCALE,
  Side,
  SignatureType,
  buildCtfExchangeCancelOrderTx,
  ctfExchangeOrderAmounts,
  ctfExchangeMakerAmountForFill,
  ctfExchangeOrderTerms,
  getCtfExchangeOrderTypedData,
  hashCtfExchangeOrder,
} from '@predex-pump/shared/tx';
import {
  isAddressEqual,
  recoverTypedDataAddress,
  zeroAddress,
  zeroHash,
  type Hex,
} from 'viem';

import { toOrderDto } from '../api/dto.js';
import type { ServerEventBus } from '../events/bus.js';
import { fillabilityForOrders, findSignedOrdersWithFillability } from './fillability.js';
import { OrderIngestError } from './input.js';
import {
  signedOrderCreateData,
  signedOrderFromRow,
  signedOrderFromWire,
  toOffchainOrderDto,
} from './order.js';
import type { FreshOrderChainState, OrderChainReader } from './chain-reader.js';

const MAX_EVENT_LOG_INDEX = 2_147_483_647;
const MAX_FEE_RATE_BPS = 10_000n;

type Tx = Prisma.TransactionClient;

export class OrderAccessError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function unixNow(): number {
  return Math.floor(Date.now() / 1_000);
}

function reject(
  code: ConstructorParameters<typeof OrderIngestError>[0],
  message: string,
): never {
  throw new OrderIngestError(code, message);
}

function isNewer(
  blockNumber: number,
  logIndex: number,
  existing: { blockNumber: number; logIndex: number } | null,
): boolean {
  return (
    existing === null ||
    blockNumber > existing.blockNumber ||
    (blockNumber === existing.blockNumber && logIndex > existing.logIndex)
  );
}

export async function persistOrderValidationSnapshot(
  tx: Tx,
  order: ReturnType<typeof signedOrderFromWire>,
  state: FreshOrderChainState,
  now: number,
): Promise<void> {
  await tx.exchangeTokenRegistration.upsert({
    where: { tokenId: order.tokenId.toString() },
    create: {
      tokenId: order.tokenId.toString(),
      complementTokenId: state.complementTokenId.toString(),
      conditionId: state.registeredConditionId.toLowerCase(),
      blockNumber: state.blockNumber,
      logIndex: MAX_EVENT_LOG_INDEX,
      registeredAt: now,
    },
    update: {},
  });

  if (state.approvalKind === 'CTF_APPROVAL_FOR_ALL') {
    const existing = await tx.ctfExchangeApproval.findUnique({
      where: { owner: order.maker.toLowerCase() },
    });
    if (isNewer(state.blockNumber, MAX_EVENT_LOG_INDEX, existing)) {
      await tx.ctfExchangeApproval.upsert({
        where: { owner: order.maker.toLowerCase() },
        create: {
          owner: order.maker.toLowerCase(),
          approved: state.ctfApprovedForAll === true,
          blockNumber: state.blockNumber,
          logIndex: MAX_EVENT_LOG_INDEX,
          updatedAt: now,
        },
        update: {
          approved: state.ctfApprovedForAll === true,
          blockNumber: state.blockNumber,
          logIndex: MAX_EVENT_LOG_INDEX,
          updatedAt: now,
        },
      });
    }
    return;
  }

  const owner = order.maker.toLowerCase();
  const [existingApproval, existingBalance] = await Promise.all([
    tx.collateralExchangeApproval.findUnique({ where: { owner } }),
    tx.collateralBalance.findUnique({ where: { owner } }),
  ]);
  if (isNewer(state.blockNumber, MAX_EVENT_LOG_INDEX, existingApproval)) {
    await tx.collateralExchangeApproval.upsert({
      where: { owner },
      create: {
        owner,
        allowanceRaw: (state.collateralAllowance ?? 0n).toString(),
        blockNumber: state.blockNumber,
        logIndex: MAX_EVENT_LOG_INDEX,
        updatedAt: now,
      },
      update: {
        allowanceRaw: (state.collateralAllowance ?? 0n).toString(),
        blockNumber: state.blockNumber,
        logIndex: MAX_EVENT_LOG_INDEX,
        updatedAt: now,
      },
    });
  }
  if (isNewer(state.blockNumber, MAX_EVENT_LOG_INDEX, existingBalance)) {
    await tx.collateralBalance.upsert({
      where: { owner },
      create: {
        owner,
        balanceRaw: state.makerAssetBalance.toString(),
        blockNumber: state.blockNumber,
        logIndex: MAX_EVENT_LOG_INDEX,
        updatedAt: now,
      },
      update: {
        balanceRaw: state.makerAssetBalance.toString(),
        blockNumber: state.blockNumber,
        logIndex: MAX_EVENT_LOG_INDEX,
        updatedAt: now,
      },
    });
  }
}

export class OffchainOrderService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly chainReader: OrderChainReader,
    private readonly eventBus: ServerEventBus,
    private readonly now: () => number = unixNow,
  ) {}

  async ingest(request: IngestOrderRequest): Promise<IngestOrderResponse> {
    const order = signedOrderFromWire(request.order);
    const computedHash = hashCtfExchangeOrder(order).toLowerCase();
    if (computedHash !== request.orderHash.toLowerCase()) {
      reject(
        'ORDER_HASH_MISMATCH',
        'Submitted orderHash does not match the EIP-712 order digest',
      );
    }
    if (order.signatureType !== SignatureType.EOA) {
      reject(
        'UNSUPPORTED_SIGNATURE_TYPE',
        'This operator currently accepts EOA-signed orders only',
      );
    }

    const effectiveSigner = isAddressEqual(order.signer, zeroAddress)
      ? order.maker
      : order.signer;
    let recovered: `0x${string}`;
    try {
      recovered = await recoverTypedDataAddress({
        ...getCtfExchangeOrderTypedData(order),
        signature: order.signature,
      });
    } catch {
      reject('BAD_SIGNATURE', 'Order signature could not be recovered');
    }
    if (!isAddressEqual(recovered, effectiveSigner)) {
      reject('BAD_SIGNATURE', 'Order signature does not recover to its signer');
    }
    if (!isAddressEqual(effectiveSigner, order.maker)) {
      reject(
        'SIGNER_UNAUTHORIZED',
        'EOA order signer must be the same address as the maker',
      );
    }
    if (!isAddressEqual(order.taker, zeroAddress)) {
      reject(
        'INVALID_TAKER',
        'Operator-book orders must be open to the zero-address taker',
      );
    }

    // Tick policy is intentionally ingest-time only. An idempotent replay of a
    // digest already accepted under an earlier market tick returns that same
    // resting order without retroactively applying the current tick.
    const existing = await this.prisma.signedOrder.findUnique({
      where: { orderHash: computedHash },
    });
    if (existing !== null) {
      if (existing.status === 'WITHDRAWN' || existing.withdrawnAt !== null) {
        reject(
          'ORDER_ALREADY_WITHDRAWN',
          'This signed order was already withdrawn from the operator book',
        );
      }
      const fillability =
        (await fillabilityForOrders(this.prisma, [existing], this.now())).get(
          existing.orderHash,
        ) ?? { fillable: false, reason: 'INDEXED_STATE_UNAVAILABLE' };
      return { order: toOffchainOrderDto(existing, fillability) };
    }

    let terms: ReturnType<typeof ctfExchangeOrderTerms>;
    try {
      terms = ctfExchangeOrderTerms(order);
    } catch {
      reject('INVALID_SIZE', 'Order amounts must encode a non-zero token size');
    }
    if (terms.priceRaw === 0n || terms.priceRaw > CTF_EXCHANGE_PRICE_SCALE) {
      reject('INVALID_PRICE', 'Order price must be greater than 0 and at most 1 USDC');
    }
    if (!isOrderSizeGranular(terms.sizeRaw)) {
      reject(
        'INVALID_SIZE',
        'Order size must be a positive multiple of 1000 raw token units so partial-fill remainders stay exactly representable',
      );
    }
    if (order.feeRateBps > MAX_FEE_RATE_BPS) {
      reject('INVALID_FEE', 'Order feeRateBps must not exceed 10000');
    }

    const market = await this.prisma.market.findFirst({
      where: {
        OR: [
          { yesTokenId: order.tokenId.toString() },
          { noTokenId: order.tokenId.toString() },
        ],
      },
      include: { resolution: { select: { marketId: true } } },
    });
    if (market === null || market.yesTokenId === null || market.noTokenId === null) {
      reject('MARKET_NOT_FOUND', 'Order token is not bound to an indexed Predex market');
    }
    if (market.resolution !== null) {
      reject('MARKET_RESOLVED', `Market ${market.id} is already resolved`);
    }
    const minimumTickSizeRaw = BigInt(market.minimumTickSizeRaw);
    assertAllowedMinimumTickSizeRaw(minimumTickSizeRaw);
    if (!isPriceOnTick(terms.priceRaw, minimumTickSizeRaw)) {
      reject(
        'PRICE_NOT_ON_TICK',
        `Order price ${terms.priceRaw} must be an exact multiple of market ${market.id} minimumTickSizeRaw ${minimumTickSizeRaw}`,
      );
    }
    const canonicalAmounts = ctfExchangeOrderAmounts({
      side: order.side,
      priceRaw: terms.priceRaw,
      sizeRaw: terms.sizeRaw,
    });
    if (
      order.makerAmount !== canonicalAmounts.makerAmount ||
      order.takerAmount !== canonicalAmounts.takerAmount
    ) {
      reject(
        'INVALID_PRICE',
        'Signed maker/taker amounts must exactly encode the declared price and size',
      );
    }

    let chainState: FreshOrderChainState;
    try {
      chainState = await this.chainReader.readOrderState(
        order,
        market.conditionId as Hex,
      );
    } catch {
      throw new OrderIngestError(
        'CHAIN_READ_FAILED',
        'Fresh Arc validation state is temporarily unavailable',
        503,
      );
    }
    if (order.nonce !== chainState.makerNonce) {
      reject(
        'WRONG_NONCE',
        `Order nonce ${order.nonce} does not equal makerNonce ${chainState.makerNonce}`,
      );
    }
    if (
      chainState.registeredConditionId.toLowerCase() === zeroHash ||
      chainState.complementTokenId === 0n
    ) {
      reject('TOKEN_NOT_REGISTERED', 'Order token is not registered on CTFExchange');
    }
    const expectedComplement =
      market.yesTokenId === order.tokenId.toString()
        ? market.noTokenId
        : market.yesTokenId;
    if (
      chainState.registeredConditionId.toLowerCase() !==
        market.conditionId.toLowerCase() ||
      chainState.complementTokenId.toString() !== expectedComplement
    ) {
      reject(
        'TOKEN_PAIR_MISMATCH',
        'CTFExchange token registration does not match the indexed market pair',
      );
    }
    if (chainState.registeredTradingEndsAt !== BigInt(market.tradingEndsAt)) {
      reject(
        'TOKEN_PAIR_MISMATCH',
        'CTFExchange token registration deadline does not match the indexed market',
      );
    }
    if (chainState.payoutDenominator !== 0n) {
      reject('MARKET_RESOLVED', `Market ${market.id} is already resolved on-chain`);
    }
    if (chainState.blockTimestamp >= chainState.registeredTradingEndsAt) {
      reject(
        'TRADING_ENDED',
        `Market ${market.id} reached its global trading deadline`,
      );
    }
    if (
      order.expiration !== 0n &&
      order.expiration <= chainState.blockTimestamp
    ) {
      reject('EXPIRED', 'Order expiration is not later than the latest Arc block');
    }
    const requiredMakerAsset = ctfExchangeMakerAmountForFill(order, terms.sizeRaw);
    if (chainState.makerAssetBalance < requiredMakerAsset) {
      reject(
        'INSUFFICIENT_BALANCE',
        `Maker balance is below the ${requiredMakerAsset} raw units required by the order`,
      );
    }
    const approved =
      order.side === Side.BUY
        ? (chainState.collateralAllowance ?? 0n) >= requiredMakerAsset
        : chainState.ctfApprovedForAll === true;
    if (!approved) {
      reject(
        'MISSING_APPROVAL',
        order.side === Side.BUY
          ? 'Collateral allowance for CTFExchange is below the order requirement'
          : 'CTF ApprovalForAll for CTFExchange is not granted',
      );
    }

    const now = this.now();
    const outcome = market.yesTokenId === order.tokenId.toString() ? 'YES' : 'NO';
    const stored = await this.prisma.$transaction(async (tx) => {
      await persistOrderValidationSnapshot(tx, order, chainState, now);
      return tx.signedOrder.upsert({
        where: { orderHash: computedHash },
        create: signedOrderCreateData({
          orderHash: computedHash,
          order,
          marketId: market.id,
          conditionId: market.conditionId,
          outcome,
          now,
        }),
        update: {},
      });
    });

    const fillability =
      (await fillabilityForOrders(this.prisma, [stored], now)).get(stored.orderHash) ??
      { fillable: true, reason: null };
    const dto = toOffchainOrderDto(stored, fillability);
    this.eventBus.publish(
      {
        channel: `book:${stored.marketId}`,
        event: 'offchain.order.placed',
        data: dto,
      },
      now,
    );
    return { order: dto };
  }

  async listMakerOrders(maker: string): Promise<MakerOrdersResponse> {
    const now = this.now();
    const normalizedMaker = maker.toLowerCase();
    const [rows, onchainRows] = await Promise.all([
      findSignedOrdersWithFillability(
        this.prisma,
        {
          maker: normalizedMaker,
          status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
          withdrawnAt: null,
        },
        now,
      ),
      this.prisma.order.findMany({
        where: { maker: normalizedMaker, open: true },
        orderBy: [{ createdAt: 'desc' }, { orderId: 'desc' }],
      }),
    ]);
    return {
      orders: rows.map(({ order, fillability }) =>
        toOffchainOrderDto(order, fillability),
      ),
      onchainOrders: onchainRows
        .filter((order) => BigInt(order.remainingRaw) > 0n)
        .map(toOrderDto),
      offchainWithdrawalIsOnchainCancellation: false,
      warning: OFFCHAIN_WITHDRAWAL_WARNING,
    };
  }

  async withdraw(orderHash: string, maker: string): Promise<WithdrawOrderResponse> {
    const existing = await this.prisma.signedOrder.findUnique({
      where: { orderHash },
    });
    if (existing === null) throw new OrderAccessError(404, 'Signed order was not found');
    if (existing.maker !== maker) {
      throw new OrderAccessError(403, 'Only the order maker may withdraw this order');
    }
    if (
      existing.withdrawnAt === null &&
      existing.status !== 'OPEN' &&
      existing.status !== 'PARTIALLY_FILLED'
    ) {
      throw new OrderAccessError(409, 'Only an active order can be withdrawn');
    }
    const now = this.now();
    const order =
      existing.withdrawnAt === null &&
      (existing.status === 'OPEN' || existing.status === 'PARTIALLY_FILLED')
        ? await this.prisma.signedOrder.update({
            where: { orderHash },
            data: { status: 'WITHDRAWN', withdrawnAt: now, updatedAt: now },
          })
        : existing;
    const dto = toOffchainOrderDto(order, {
      fillable: false,
      reason: 'WITHDRAWN',
    });
    const cancelTx = buildCtfExchangeCancelOrderTx({
      order: signedOrderFromRow(order),
    });
    this.eventBus.publish(
      {
        channel: `book:${order.marketId}`,
        event: 'offchain.order.withdrawn',
        data: dto,
      },
      now,
    );
    return {
      order: dto,
      offchainWithdrawalIsOnchainCancellation: false,
      signedOrderMayRemainValidOnchain: true,
      warning: OFFCHAIN_WITHDRAWAL_WARNING,
      authoritativeCancelOrderTx: {
        to: cancelTx.to,
        data: cancelTx.data,
        valueRaw: cancelTx.value.toString(),
      },
    };
  }
}

export type { SignedOrder };
