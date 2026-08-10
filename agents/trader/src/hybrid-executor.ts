import {
  arcAgentChain,
  createWriteClient,
  OrderIngestRejectedError,
  PredexRestError,
  type PredexRestClient,
  type PredexWriteClient,
} from '@predex-pump/agent-sdk';
import {
  ADDRESSES,
  type IngestOrderRequest,
  type MakerOrdersResponse,
  type OffchainOrder,
  type OrderIngestRejectionCode,
  type WithdrawOrderResponse,
} from '@predex-pump/shared';
import {
  buildCtfExchangeApprovalForAllTx,
  buildCtfExchangeCancelOrderTx,
  buildCtfExchangeCollateralApprovalTx,
  buildCtfExchangeFillOrderTx,
  buildCtfExchangeOrder,
  collateralErc20Abi,
  ctfExchangeAbi,
  ctfExchangeMakerAmountForFill,
  ctfExchangeOrderFromWire,
  ctfExchangeOrderTerms,
  ctfExchangeOrderToWire,
  ctfExchangeTakerAmountForFill,
  hashCtfExchangeOrder,
  orderExpirationFromTimestamp,
  Side,
  signCtfExchangeOrder,
  type CtfExchangeOrder,
  type TxRequest,
} from '@predex-pump/shared/tx';
import conditionalTokensAbiJson from '@predex-pump/shared/abis/ConditionalTokens.json' with {
  type: 'json',
};
import {
  createPublicClient,
  http,
  isAddressEqual,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
} from 'viem';
import { createSiweMessage } from 'viem/siwe';

import {
  BroadcastUncertainError,
  type HybridCancelOrderAction,
  type HybridFillOrderAction,
  type HybridPlaceOrderAction,
  type HybridPlaceOrderResult,
  type HybridTraderExecutor,
  type HybridWithdrawOrderAction,
} from './agent.js';

const conditionalTokensAbi = conditionalTokensAbiJson as Abi;

export type OrderIngestClassification = 'permanent' | 'retryable';

export interface OrderIngestRejectionPolicy {
  classification: OrderIngestClassification;
  reason: string;
}

/**
 * A retryable response gets one corrective retry. A permanent response
 * suppresses the same market/outcome/side/price/size for this process so a
 * deterministic bad quote cannot hammer POST /orders every polling cycle.
 */
export const ORDER_INGEST_REJECTION_POLICY = {
  BAD_SIGNATURE: {
    classification: 'permanent',
    reason: 'the EIP-712 signature did not verify for the declared signer',
  },
  WRONG_NONCE: {
    classification: 'retryable',
    reason: 'the maker nonce changed; fresh chain state and a new signature are required',
  },
  EXPIRED: {
    classification: 'permanent',
    reason: 'the signed order had already expired when validated',
  },
  INSUFFICIENT_BALANCE: {
    classification: 'permanent',
    reason: 'the maker did not own enough of the offered asset for this order',
  },
  MISSING_APPROVAL: {
    classification: 'retryable',
    reason: 'the exchange approval was missing; approval state will be refreshed once',
  },
  MARKET_RESOLVED: {
    classification: 'permanent',
    reason: 'the market is resolved and no longer accepts exchange orders',
  },
  TOKEN_NOT_REGISTERED: {
    classification: 'permanent',
    reason: 'the position token is not registered with the deployed exchange',
  },
  INVALID_PRICE: {
    classification: 'permanent',
    reason: 'the signed price is outside the exchange range',
  },
  INVALID_SIZE: {
    classification: 'permanent',
    reason: 'the signed amounts do not represent a positive token size',
  },
  INVALID_FEE: {
    classification: 'permanent',
    reason: 'the signed fee is outside the operator policy',
  },
  INVALID_TAKER: {
    classification: 'permanent',
    reason: 'operator-book orders must be open to the zero-address taker',
  },
  MALFORMED_ORDER: {
    classification: 'permanent',
    reason: 'the submitted wire order did not match the REST schema',
  },
  MARKET_NOT_FOUND: {
    classification: 'permanent',
    reason: 'the token was not bound to an indexed Predex market',
  },
  ORDER_HASH_MISMATCH: {
    classification: 'permanent',
    reason: 'the submitted digest did not match the signed EIP-712 fields',
  },
  SIGNER_UNAUTHORIZED: {
    classification: 'permanent',
    reason: 'the signer was not authorized for the declared maker',
  },
  TOKEN_PAIR_MISMATCH: {
    classification: 'permanent',
    reason: 'the exchange token pair did not match the indexed market binding',
  },
  UNSUPPORTED_SIGNATURE_TYPE: {
    classification: 'permanent',
    reason: 'the operator does not support the selected signature type',
  },
  CHAIN_READ_FAILED: {
    classification: 'retryable',
    reason: 'the operator could not read transaction-critical Arc state',
  },
} as const satisfies Record<
  OrderIngestRejectionCode,
  OrderIngestRejectionPolicy
>;

interface ChainBlock {
  number: bigint | null;
  timestamp: bigint;
}

interface ChainReceipt {
  status: 'success' | 'reverted';
  logs: readonly unknown[];
}

export interface HybridChainClient {
  getBlock(parameters?: { blockTag?: 'latest' }): Promise<ChainBlock>;
  readContract(parameters: {
    address: Address;
    abi: Abi | readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown>;
  waitForTransactionReceipt(parameters: { hash: Hash }): Promise<ChainReceipt>;
}

export type HybridWriteClient = Pick<PredexWriteClient, 'send'>;

export type HybridRestClient = Pick<
  PredexRestClient,
  | 'getSiweNonce'
  | 'verifySiwe'
  | 'getSession'
  | 'getMakerOrders'
  | 'postOrder'
  | 'withdrawOrder'
>;

export interface ArcHybridTraderExecutorOptions {
  orderLifetimeSeconds: bigint;
  nowMilliseconds?: () => number;
}

export class HybridOrderIngestError extends Error {
  constructor(
    readonly code: OrderIngestRejectionCode,
    readonly classification: OrderIngestClassification,
    readonly attempts: number,
    message: string,
  ) {
    super(message);
    this.name = 'HybridOrderIngestError';
  }
}

export class HybridOrderSuppressedError extends Error {
  constructor(
    readonly code: OrderIngestRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'HybridOrderSuppressedError';
  }
}

interface StoredSession {
  cookie: string;
  expiresAtMilliseconds: number;
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireUnsigned(value: string, label: string): bigint {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${label} must be an unsigned decimal integer.`);
  }
  return BigInt(value);
}

function isActiveOrderStatus(status: OffchainOrder['status']): boolean {
  return status === 'OPEN' || status === 'PARTIALLY_FILLED';
}

function registryTuple(value: unknown): readonly [bigint, Hex] {
  if (
    Array.isArray(value) &&
    typeof value[0] === 'bigint' &&
    typeof value[1] === 'string'
  ) {
    return [value[0], value[1] as Hex];
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (
      typeof record.complement === 'bigint' &&
      typeof record.conditionId === 'string'
    ) {
      return [record.complement, record.conditionId as Hex];
    }
  }
  throw new Error('CTFExchange registry returned an unexpected value.');
}

function rejectionMessage(
  code: OrderIngestRejectionCode,
  attempts: number,
): string {
  const policy = ORDER_INGEST_REJECTION_POLICY[code];
  const retry =
    policy.classification === 'retryable'
      ? attempts > 1
        ? 'the single corrective retry was exhausted'
        : 'one corrective retry is allowed'
      : 'this economic order is now suppressed';
  return (
    `Hybrid order rejected with ${code} (${policy.classification}): ` +
    `${policy.reason}; ${retry}.`
  );
}

class HeadlessSiweSession {
  private session: StoredSession | null = null;

  constructor(
    private readonly account: LocalAccount,
    private readonly rest: HybridRestClient,
    private readonly nowMilliseconds: () => number,
  ) {}

  private async authenticate(): Promise<string> {
    const nonce = await this.rest.getSiweNonce();
    const message = createSiweMessage({
      address: this.account.address,
      chainId: nonce.chainId,
      domain: nonce.domain,
      uri: nonce.uri,
      version: '1',
      statement: nonce.statement,
      nonce: nonce.nonce,
      issuedAt: new Date(nonce.issuedAt),
      expirationTime: new Date(nonce.expirationTime),
    });
    const signature = await this.account.signMessage({ message });
    const verified = await this.rest.verifySiwe({ message, signature });
    if (!verified.session.authenticated) {
      throw new Error('SIWE verification returned an anonymous session.');
    }
    if (!isAddressEqual(verified.session.address, this.account.address)) {
      throw new Error('SIWE session address does not match the trader account.');
    }
    const expiresAtMilliseconds = Date.parse(verified.session.expiresAt);
    if (!Number.isFinite(expiresAtMilliseconds)) {
      throw new Error('SIWE verification returned an invalid session expiry.');
    }
    this.session = {
      cookie: verified.sessionCookie,
      expiresAtMilliseconds,
    };
    return verified.sessionCookie;
  }

  private async cookie(): Promise<string> {
    if (
      this.session !== null &&
      this.session.expiresAtMilliseconds > this.nowMilliseconds() + 1_000
    ) {
      return this.session.cookie;
    }
    this.session = null;
    return this.authenticate();
  }

  async request<T>(operation: (cookie: string) => Promise<T>): Promise<T> {
    let cookie = await this.cookie();
    try {
      return await operation(cookie);
    } catch (error) {
      if (!(error instanceof PredexRestError) || error.status !== 401) {
        throw error;
      }
      this.session = null;
      cookie = await this.authenticate();
      return operation(cookie);
    }
  }
}

interface FreshPlaceState {
  blockNumber: bigint;
  blockTimestamp: bigint;
  makerNonce: bigint;
}

interface FreshFillState {
  blockNumber: bigint;
  order: CtfExchangeOrder;
}

export class ArcHybridTraderExecutor implements HybridTraderExecutor {
  private readonly session: HeadlessSiweSession;
  private readonly permanentlyRejected = new Map<
    string,
    { code: OrderIngestRejectionCode; reason: string }
  >();

  constructor(
    private readonly account: LocalAccount,
    private readonly chainClient: HybridChainClient,
    private readonly writeClient: HybridWriteClient,
    private readonly restClient: HybridRestClient,
    private readonly options: ArcHybridTraderExecutorOptions,
  ) {
    if (options.orderLifetimeSeconds <= 0n) {
      throw new Error('Hybrid order lifetime must be positive.');
    }
    this.session = new HeadlessSiweSession(
      account,
      restClient,
      options.nowMilliseconds ?? Date.now,
    );
  }

  private async latestBlock(): Promise<{ number: bigint; timestamp: bigint }> {
    const block = await this.chainClient.getBlock({ blockTag: 'latest' });
    if (block.number === null) {
      throw new Error('Latest Arc block omitted its number.');
    }
    return { number: block.number, timestamp: block.timestamp };
  }

  private async waitForSuccess(
    hash: Hash,
    label: string,
    actionMayHaveCommitted: boolean,
  ): Promise<void> {
    let receipt: ChainReceipt;
    try {
      receipt = await this.chainClient.waitForTransactionReceipt({ hash });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BroadcastUncertainError(
        hash,
        actionMayHaveCommitted,
        `${label} ${hash} was broadcast but its receipt could not be read: ${message}`,
      );
    }
    if (receipt.status !== 'success') {
      throw new Error(`${label} transaction ${hash} reverted.`);
    }
  }

  private async send(
    transaction: TxRequest,
    label: string,
    actionMayHaveCommitted: boolean,
  ): Promise<Hash> {
    let hash: Hash;
    try {
      hash = await this.writeClient.send(transaction);
    } catch {
      // Wallet/RPC errors may render transaction calldata. Hybrid fill/cancel
      // calldata embeds the full signed order, so never propagate that text to
      // the agent logger.
      throw new Error(
        `${label} submission failed before a transaction hash was returned.`,
      );
    }
    await this.waitForSuccess(hash, label, actionMayHaveCommitted);
    return hash;
  }

  private async readPlaceState(
    action: HybridPlaceOrderAction,
  ): Promise<FreshPlaceState> {
    const block = await this.latestBlock();
    const tokenId = requireUnsigned(action.tokenId, 'tokenId');
    const complementTokenId = requireUnsigned(
      action.complementTokenId,
      'complementTokenId',
    );
    const [makerNonceValue, registryValue, payoutDenominatorValue] =
      await Promise.all([
        this.chainClient.readContract({
          address: ADDRESSES.ctfExchange,
          abi: ctfExchangeAbi,
          functionName: 'makerNonce',
          args: [this.account.address],
          blockNumber: block.number,
        }),
        this.chainClient.readContract({
          address: ADDRESSES.ctfExchange,
          abi: ctfExchangeAbi,
          functionName: 'registry',
          args: [tokenId],
          blockNumber: block.number,
        }),
        this.chainClient.readContract({
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'payoutDenominator',
          args: [action.conditionId],
          blockNumber: block.number,
        }),
      ]);
    if (
      typeof makerNonceValue !== 'bigint' ||
      typeof payoutDenominatorValue !== 'bigint'
    ) {
      throw new Error('Arc returned unexpected Hybrid placement state.');
    }
    const [registeredComplement, registeredCondition] =
      registryTuple(registryValue);
    if (
      registeredComplement === 0n ||
      sameHex(registeredCondition, zeroHash) ||
      registeredComplement !== complementTokenId ||
      !sameHex(registeredCondition, action.conditionId)
    ) {
      throw new Error(
        'Fresh CTFExchange token registration differs from the indexed market.',
      );
    }
    if (payoutDenominatorValue !== 0n) {
      throw new Error('Fresh Arc condition is resolved; placement is forbidden.');
    }
    return {
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
      makerNonce: makerNonceValue,
    };
  }

  /** Returns true only when the maker asset is already approved at this block. */
  private async ensurePlacementAsset(
    order: CtfExchangeOrder,
    blockNumber: bigint,
  ): Promise<boolean> {
    const { sizeRaw } = ctfExchangeOrderTerms(order);
    const required = ctfExchangeMakerAmountForFill(order, sizeRaw);
    if (order.side === Side.BUY) {
      const [balanceValue, allowanceValue] = await Promise.all([
        this.chainClient.readContract({
          address: ADDRESSES.usdc,
          abi: collateralErc20Abi,
          functionName: 'balanceOf',
          args: [this.account.address],
          blockNumber,
        }),
        this.chainClient.readContract({
          address: ADDRESSES.usdc,
          abi: collateralErc20Abi,
          functionName: 'allowance',
          args: [this.account.address, ADDRESSES.ctfExchange],
          blockNumber,
        }),
      ]);
      if (typeof balanceValue !== 'bigint' || typeof allowanceValue !== 'bigint') {
        throw new Error('Arc returned unexpected collateral approval state.');
      }
      if (balanceValue < required) {
        throw new Error(
          `Fresh Arc USDC balance ${balanceValue} is below Hybrid order requirement ${required}.`,
        );
      }
      if (allowanceValue >= required) return true;
      await this.send(
        buildCtfExchangeCollateralApprovalTx({ amountRaw: required }),
        'exact CTFExchange collateral approval',
        false,
      );
      return false;
    }

    const [balanceValue, approvedValue] = await Promise.all([
      this.chainClient.readContract({
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'balanceOf',
        args: [this.account.address, order.tokenId],
        blockNumber,
      }),
      this.chainClient.readContract({
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'isApprovedForAll',
        args: [this.account.address, ADDRESSES.ctfExchange],
        blockNumber,
      }),
    ]);
    if (typeof balanceValue !== 'bigint' || typeof approvedValue !== 'boolean') {
      throw new Error('Arc returned unexpected position-token approval state.');
    }
    if (balanceValue < required) {
      throw new Error(
        `Fresh Arc CTF balance ${balanceValue} is below Hybrid order requirement ${required}.`,
      );
    }
    if (approvedValue) return true;
    await this.send(
      buildCtfExchangeApprovalForAllTx(),
      'CTFExchange position-token approval',
      false,
    );
    return false;
  }

  private async buildSignedOrder(
    action: HybridPlaceOrderAction,
  ): Promise<IngestOrderRequest> {
    for (let approvalPass = 0; approvalPass < 2; approvalPass += 1) {
      const fresh = await this.readPlaceState(action);
      const unsigned = buildCtfExchangeOrder({
        maker: this.account.address,
        tokenId: requireUnsigned(action.tokenId, 'tokenId'),
        side: action.side === 'BID' ? Side.BUY : Side.SELL,
        priceRaw: action.priceRaw,
        sizeRaw: action.sizeRaw,
        expiration: orderExpirationFromTimestamp(
          fresh.blockTimestamp,
          this.options.orderLifetimeSeconds,
        ),
        nonce: fresh.makerNonce,
      });
      if (!(await this.ensurePlacementAsset(unsigned, fresh.blockNumber))) {
        continue;
      }
      const signed = await signCtfExchangeOrder(this.account, unsigned);
      return {
        orderHash: hashCtfExchangeOrder(signed),
        order: ctfExchangeOrderToWire(signed),
      };
    }
    throw new Error(
      'Live CTFExchange approval remained insufficient after the exact approval.',
    );
  }

  private placementFingerprint(action: HybridPlaceOrderAction): string {
    return [
      action.marketId,
      action.conditionId.toLowerCase(),
      action.tokenId,
      action.outcome,
      action.side,
      action.priceRaw.toString(),
      action.sizeRaw.toString(),
    ].join(':');
  }

  async placeOrder(
    action: HybridPlaceOrderAction,
  ): Promise<HybridPlaceOrderResult> {
    const fingerprint = this.placementFingerprint(action);
    const suppressed = this.permanentlyRejected.get(fingerprint);
    if (suppressed !== undefined) {
      throw new HybridOrderSuppressedError(
        suppressed.code,
        `Hybrid placement suppressed after permanent ${suppressed.code}: ${suppressed.reason}.`,
      );
    }

    const rejections: HybridPlaceOrderResult['rejections'] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const request = await this.buildSignedOrder(action);
      try {
        const posted = await this.restClient.postOrder(request);
        if (!sameHex(posted.order.orderHash, request.orderHash)) {
          throw new Error(
            'Hybrid operator returned an accepted order with a different digest.',
          );
        }
        return { orderHash: posted.order.orderHash, rejections };
      } catch (error) {
        if (!(error instanceof OrderIngestRejectedError)) {
          // A transport implementation may include the request body in its
          // exception. Do not let a full signed order reach agent logs.
          throw new Error(
            'Hybrid signed-order POST failed before the operator returned a typed response.',
          );
        }
        const policy = ORDER_INGEST_REJECTION_POLICY[error.code];
        rejections.push({
          code: error.code,
          classification: policy.classification,
          reason: policy.reason,
        });
        const message = rejectionMessage(error.code, attempt);
        if (policy.classification === 'permanent') {
          this.permanentlyRejected.set(fingerprint, {
            code: error.code,
            reason: policy.reason,
          });
          throw new HybridOrderIngestError(
            error.code,
            policy.classification,
            attempt,
            message,
          );
        }
        if (attempt === 2) {
          throw new HybridOrderIngestError(
            error.code,
            policy.classification,
            attempt,
            message,
          );
        }
      }
    }
    throw new Error('Hybrid placement retry loop exited unexpectedly.');
  }

  async getMakerOrders(): Promise<MakerOrdersResponse> {
    return this.session.request((cookie) =>
      this.restClient.getMakerOrders(cookie),
    );
  }

  private validateActionOrder(
    action: HybridFillOrderAction,
  ): CtfExchangeOrder {
    const dto = action.order;
    const order = ctfExchangeOrderFromWire(dto.signedOrder);
    if (!dto.fillable || !isActiveOrderStatus(dto.status)) {
      throw new Error('Hybrid order is not active and fillable in the live book.');
    }
    if (!sameHex(hashCtfExchangeOrder(order), dto.orderHash)) {
      throw new Error('Hybrid order digest differs from its signed fields.');
    }
    if (isAddressEqual(order.maker, this.account.address)) {
      throw new Error('Refusing to self-fill the signing account\'s Hybrid order.');
    }
    if (!isAddressEqual(order.maker, dto.maker)) {
      throw new Error('Hybrid maker differs from its signed fields.');
    }
    if (!isAddressEqual(order.taker, zeroAddress)) {
      throw new Error('Hybrid operator order is not open to this taker.');
    }
    if (
      order.tokenId !== requireUnsigned(action.tokenId, 'tokenId') ||
      order.tokenId !== requireUnsigned(dto.tokenId, 'order tokenId') ||
      !sameHex(dto.conditionId, action.conditionId) ||
      dto.marketId !== action.marketId ||
      dto.outcome !== action.outcome
    ) {
      throw new Error('Hybrid order binding differs from the decision input.');
    }
    const expectedSide = action.restingSide === 'BID' ? Side.BUY : Side.SELL;
    const terms = ctfExchangeOrderTerms(order);
    if (
      order.side !== expectedSide ||
      dto.side !== action.restingSide ||
      terms.priceRaw !== action.expectedPriceRaw ||
      terms.priceRaw !== BigInt(dto.priceRaw)
    ) {
      throw new Error('Hybrid order side or price differs from the decision input.');
    }
    if (
      action.fillSizeRaw <= 0n ||
      action.fillSizeRaw > BigInt(dto.remainingRaw)
    ) {
      throw new Error('Exact Hybrid fill exceeds the indexed remaining size.');
    }
    return order;
  }

  private async readFreshFill(
    action: HybridFillOrderAction,
  ): Promise<FreshFillState & { takerApprovalReady: boolean }> {
    const order = this.validateActionOrder(action);
    const block = await this.latestBlock();
    const orderHash = hashCtfExchangeOrder(order);
    const complementTokenId = requireUnsigned(
      action.complementTokenId,
      'complementTokenId',
    );
    const [
      makerNonceValue,
      registryValue,
      payoutDenominatorValue,
      cancelledValue,
      filledValue,
      makerBalanceValue,
      makerApprovalValue,
      takerBalanceValue,
      takerApprovalValue,
    ] = await Promise.all([
      this.chainClient.readContract({
        address: ADDRESSES.ctfExchange,
        abi: ctfExchangeAbi,
        functionName: 'makerNonce',
        args: [order.maker],
        blockNumber: block.number,
      }),
      this.chainClient.readContract({
        address: ADDRESSES.ctfExchange,
        abi: ctfExchangeAbi,
        functionName: 'registry',
        args: [order.tokenId],
        blockNumber: block.number,
      }),
      this.chainClient.readContract({
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'payoutDenominator',
        args: [action.conditionId],
        blockNumber: block.number,
      }),
      this.chainClient.readContract({
        address: ADDRESSES.ctfExchange,
        abi: ctfExchangeAbi,
        functionName: 'cancelledOrders',
        args: [orderHash],
        blockNumber: block.number,
      }),
      this.chainClient.readContract({
        address: ADDRESSES.ctfExchange,
        abi: ctfExchangeAbi,
        functionName: 'filledAmount',
        args: [orderHash],
        blockNumber: block.number,
      }),
      this.chainClient.readContract({
        address: order.side === Side.BUY ? ADDRESSES.usdc : ADDRESSES.ctf,
        abi:
          order.side === Side.BUY
            ? collateralErc20Abi
            : conditionalTokensAbi,
        functionName: 'balanceOf',
        args:
          order.side === Side.BUY
            ? [order.maker]
            : [order.maker, order.tokenId],
        blockNumber: block.number,
      }),
      this.chainClient.readContract({
        address: order.side === Side.BUY ? ADDRESSES.usdc : ADDRESSES.ctf,
        abi:
          order.side === Side.BUY
            ? collateralErc20Abi
            : conditionalTokensAbi,
        functionName: order.side === Side.BUY ? 'allowance' : 'isApprovedForAll',
        args: [order.maker, ADDRESSES.ctfExchange],
        blockNumber: block.number,
      }),
      this.chainClient.readContract({
        address: order.side === Side.SELL ? ADDRESSES.usdc : ADDRESSES.ctf,
        abi:
          order.side === Side.SELL
            ? collateralErc20Abi
            : conditionalTokensAbi,
        functionName: 'balanceOf',
        args:
          order.side === Side.SELL
            ? [this.account.address]
            : [this.account.address, order.tokenId],
        blockNumber: block.number,
      }),
      this.chainClient.readContract({
        address: order.side === Side.SELL ? ADDRESSES.usdc : ADDRESSES.ctf,
        abi:
          order.side === Side.SELL
            ? collateralErc20Abi
            : conditionalTokensAbi,
        functionName:
          order.side === Side.SELL ? 'allowance' : 'isApprovedForAll',
        args: [this.account.address, ADDRESSES.ctfExchange],
        blockNumber: block.number,
      }),
    ]);
    if (
      typeof makerNonceValue !== 'bigint' ||
      typeof payoutDenominatorValue !== 'bigint' ||
      typeof cancelledValue !== 'boolean' ||
      typeof filledValue !== 'bigint' ||
      typeof makerBalanceValue !== 'bigint' ||
      typeof takerBalanceValue !== 'bigint'
    ) {
      throw new Error('Arc returned unexpected Hybrid fill state.');
    }
    const [registeredComplement, registeredCondition] =
      registryTuple(registryValue);
    if (
      registeredComplement !== complementTokenId ||
      !sameHex(registeredCondition, action.conditionId)
    ) {
      throw new Error('Fresh exchange token binding differs from the decision input.');
    }
    if (payoutDenominatorValue !== 0n) {
      throw new Error('Fresh Arc condition is resolved; fill is forbidden.');
    }
    if (makerNonceValue !== order.nonce) {
      throw new Error('Fresh makerNonce invalidates the resting Hybrid order.');
    }
    if (order.expiration !== 0n && order.expiration <= block.timestamp) {
      throw new Error('Resting Hybrid order expired before fill submission.');
    }
    if (cancelledValue) {
      throw new Error('Resting Hybrid order is already cancelled on-chain.');
    }
    if (filledValue !== BigInt(action.order.filledRaw)) {
      throw new Error('Fresh Hybrid filled amount differs from indexed state.');
    }
    const terms = ctfExchangeOrderTerms(order);
    if (terms.sizeRaw - filledValue !== BigInt(action.order.remainingRaw)) {
      throw new Error('Fresh Hybrid remaining amount differs from indexed state.');
    }

    const makerRequired = ctfExchangeMakerAmountForFill(
      order,
      action.fillSizeRaw,
    );
    if (makerBalanceValue < makerRequired) {
      throw new Error('Resting Hybrid maker balance is insufficient for this fill.');
    }
    const makerApproved =
      order.side === Side.BUY
        ? typeof makerApprovalValue === 'bigint' &&
          makerApprovalValue >= makerRequired
        : makerApprovalValue === true;
    if (!makerApproved) {
      throw new Error('Resting Hybrid maker approval is missing for this fill.');
    }

    const takerRequired = ctfExchangeTakerAmountForFill(
      order,
      action.fillSizeRaw,
    );
    if (takerBalanceValue < takerRequired) {
      throw new Error('Fresh taker balance is insufficient for this Hybrid fill.');
    }
    const takerApprovalReady =
      order.side === Side.SELL
        ? typeof takerApprovalValue === 'bigint' &&
          takerApprovalValue >= takerRequired
        : takerApprovalValue === true;
    return {
      blockNumber: block.number,
      order,
      takerApprovalReady,
    };
  }

  async fillOrder(
    action: HybridFillOrderAction,
  ): Promise<{ txHash: `0x${string}` }> {
    for (let approvalPass = 0; approvalPass < 2; approvalPass += 1) {
      const fresh = await this.readFreshFill(action);
      if (!fresh.takerApprovalReady) {
        const required = ctfExchangeTakerAmountForFill(
          fresh.order,
          action.fillSizeRaw,
        );
        await this.send(
          fresh.order.side === Side.SELL
            ? buildCtfExchangeCollateralApprovalTx({ amountRaw: required })
            : buildCtfExchangeApprovalForAllTx(),
          fresh.order.side === Side.SELL
            ? 'exact CTFExchange fill collateral approval'
            : 'CTFExchange fill position-token approval',
          false,
        );
        continue;
      }
      const txHash = await this.send(
        buildCtfExchangeFillOrderTx({
          order: fresh.order,
          fillAmount: action.fillSizeRaw,
        }),
        'CTFExchange fillOrder',
        true,
      );
      return { txHash };
    }
    throw new Error('Live counter-asset approval remained insufficient.');
  }

  async withdrawOrder(
    action: HybridWithdrawOrderAction,
  ): Promise<WithdrawOrderResponse> {
    if (!isAddressEqual(action.order.maker, this.account.address)) {
      throw new Error('Only the signing maker may withdraw a Hybrid order.');
    }
    const response = await this.session.request((cookie) =>
      this.restClient.withdrawOrder(action.order.orderHash, cookie),
    );
    if (
      response.offchainWithdrawalIsOnchainCancellation !== false ||
      response.signedOrderMayRemainValidOnchain !== true ||
      !sameHex(response.order.orderHash, action.order.orderHash)
    ) {
      throw new Error('Operator returned an inconsistent withdrawal response.');
    }
    const expected = buildCtfExchangeCancelOrderTx({
      order: ctfExchangeOrderFromWire(action.order.signedOrder),
    });
    if (
      !isAddressEqual(response.authoritativeCancelOrderTx.to, expected.to) ||
      !sameHex(response.authoritativeCancelOrderTx.data, expected.data) ||
      BigInt(response.authoritativeCancelOrderTx.valueRaw) !== expected.value
    ) {
      throw new Error(
        'Operator withdrawal returned unexpected authoritative cancelOrder calldata.',
      );
    }
    return response;
  }

  async cancelOrder(
    action: HybridCancelOrderAction,
  ): Promise<{ txHash: `0x${string}` }> {
    const order = ctfExchangeOrderFromWire(action.order.signedOrder);
    if (
      !isAddressEqual(order.maker, this.account.address) ||
      !isAddressEqual(action.order.maker, this.account.address)
    ) {
      throw new Error('Only the signing maker may cancel a Hybrid order.');
    }
    const orderHash = hashCtfExchangeOrder(order);
    if (!sameHex(orderHash, action.order.orderHash)) {
      throw new Error('Hybrid cancel digest differs from its signed fields.');
    }
    const block = await this.latestBlock();
    const cancelled = await this.chainClient.readContract({
      address: ADDRESSES.ctfExchange,
      abi: ctfExchangeAbi,
      functionName: 'cancelledOrders',
      args: [orderHash],
      blockNumber: block.number,
    });
    if (cancelled !== false) {
      if (cancelled === true) {
        throw new Error('Hybrid order is already authoritatively cancelled.');
      }
      throw new Error('Arc returned unexpected cancellation state.');
    }
    const txHash = await this.send(
      buildCtfExchangeCancelOrderTx({ order }),
      'CTFExchange cancelOrder',
      true,
    );
    return { txHash };
  }
}

export function createArcHybridTraderExecutor(
  account: LocalAccount,
  rpcUrl: string,
  restClient: HybridRestClient,
  orderLifetimeSeconds: bigint,
): ArcHybridTraderExecutor {
  const publicClient = createPublicClient({
    chain: arcAgentChain,
    transport: http(rpcUrl),
  });
  return new ArcHybridTraderExecutor(
    account,
    publicClient as unknown as HybridChainClient,
    createWriteClient({ account, rpcUrl }),
    restClient,
    { orderLifetimeSeconds },
  );
}
