import {
  ADDRESSES,
  type Address,
  type IngestOrderRequest,
  type IngestOrderResponse,
  type MakerOrdersResponse,
  type OffchainOrder,
  type OrderIngestRejectionCode,
  type WithdrawOrderResponse,
} from '@predex-pump/shared';
import {
  buildCtfExchangeCancelOrderTx,
  buildCtfExchangeApprovalForAllTx,
  buildCtfExchangeCollateralApprovalTx,
  ctfExchangeOrderFromWire,
  ctfExchangeOrderTerms,
  ctfExchangeOrderToWire,
  hashCtfExchangeOrder,
  Side,
  signCtfExchangeOrder,
  buildCtfExchangeOrder,
  ctfExchangeAbi,
  type TxRequest,
} from '@predex-pump/shared/tx';
import { PredexRestError, OrderIngestRejectedError } from '@predex-pump/agent-sdk';
import { decodeFunctionData, type Hex, type LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import type {
  HybridFillOrderAction,
  HybridPlaceOrderAction,
} from '../src/agent.js';
import {
  ArcHybridTraderExecutor,
  ORDER_INGEST_REJECTION_POLICY,
  type HybridChainClient,
  type HybridRestClient,
  type HybridWriteClient,
} from '../src/hybrid-executor.js';

const CONDITION = `0x${'12'.repeat(32)}` as Hex;
const YES_TOKEN = 101n;
const NO_TOKEN = 102n;
const TX_HASH = `0x${'34'.repeat(32)}` as Hex;
const SESSION_COOKIE = 'predex_session=test-session';

const ALL_REJECTIONS = [
  'BAD_SIGNATURE',
  'WRONG_NONCE',
  'EXPIRED',
  'INSUFFICIENT_BALANCE',
  'MISSING_APPROVAL',
  'MARKET_RESOLVED',
  'TOKEN_NOT_REGISTERED',
  'INVALID_PRICE',
  'INVALID_SIZE',
  'INVALID_FEE',
  'INVALID_TAKER',
  'MALFORMED_ORDER',
  'MARKET_NOT_FOUND',
  'ORDER_HASH_MISMATCH',
  'SIGNER_UNAUTHORIZED',
  'TOKEN_PAIR_MISMATCH',
  'UNSUPPORTED_SIGNATURE_TYPE',
  'CHAIN_READ_FAILED',
] as const satisfies readonly OrderIngestRejectionCode[];

function account(): LocalAccount {
  return privateKeyToAccount(generatePrivateKey());
}

interface ChainOptions {
  makerNonces?: bigint[];
  allowance?: bigint;
  approvedForAll?: boolean;
  blockTimestamp?: bigint;
}

function chainClient(options: ChainOptions = {}): HybridChainClient & {
  readContract: ReturnType<typeof vi.fn<HybridChainClient['readContract']>>;
} {
  let nonceRead = 0;
  return {
    getBlock: vi.fn(async () => ({
      number: 77n,
      timestamp: options.blockTimestamp ?? 1_900_000_000n,
    })),
    readContract: vi.fn(async ({ address, functionName }) => {
      switch (functionName) {
        case 'makerNonce': {
          const values = options.makerNonces ?? [7n];
          const value = values[Math.min(nonceRead, values.length - 1)];
          nonceRead += 1;
          return value ?? 7n;
        }
        case 'registry':
          return [NO_TOKEN, CONDITION] as const;
        case 'payoutDenominator':
          return 0n;
        case 'cancelledOrders':
          return false;
        case 'filledAmount':
          return 0n;
        case 'balanceOf':
          return 10_000_000n;
        case 'allowance':
          return options.allowance ?? 10_000_000n;
        case 'isApprovedForAll':
          return options.approvedForAll ?? true;
        default:
          throw new Error(`unexpected ${address} ${functionName}`);
      }
    }),
    waitForTransactionReceipt: vi.fn(async () => ({
      status: 'success' as const,
      logs: [],
    })),
  };
}

function writeClient(): HybridWriteClient & {
  send: ReturnType<typeof vi.fn<HybridWriteClient['send']>>;
} {
  return { send: vi.fn(async () => TX_HASH) };
}

function dtoFromRequest(input: IngestOrderRequest): OffchainOrder {
  const order = ctfExchangeOrderFromWire(input.order);
  const terms = ctfExchangeOrderTerms(order);
  return {
    orderHash: input.orderHash,
    marketId: '1',
    conditionId: CONDITION,
    tokenId: order.tokenId.toString(),
    outcome: 'YES',
    maker: order.maker,
    side: order.side === Side.BUY ? 'BID' : 'ASK',
    priceRaw: terms.priceRaw.toString(),
    sizeRaw: terms.sizeRaw.toString(),
    filledRaw: '0',
    remainingRaw: terms.sizeRaw.toString(),
    status: 'OPEN',
    fillable: true,
    unfillableReason: null,
    signedOrder: input.order,
    createdAt: 1_900_000_000,
    updatedAt: 1_900_000_000,
  };
}

function restClient(
  overrides: Partial<HybridRestClient> = {},
): HybridRestClient {
  return {
    getSiweNonce: vi.fn(async () => ({
      nonce: 'abcdefgh',
      domain: 'predex.test',
      uri: 'https://predex.test',
      chainId: 5_042_002,
      statement: 'Sign in.',
      issuedAt: '2030-01-01T00:00:00.000Z',
      expirationTime: '2030-01-01T00:05:00.000Z',
    })),
    verifySiwe: vi.fn(async () => ({
      session: {
        authenticated: true as const,
        address: `0x${'00'.repeat(20)}` as Address,
        expiresAt: '2030-01-08T00:00:00.000Z',
      },
      sessionCookie: SESSION_COOKIE,
    })),
    getSession: vi.fn(async () => ({ authenticated: false as const })),
    getMakerOrders: vi.fn(async () => ({
      orders: [],
      offchainWithdrawalIsOnchainCancellation: false as const,
      warning: 'Withdrawal is off-chain only.',
    })),
    postOrder: vi.fn(async (input): Promise<IngestOrderResponse> => ({
      order: dtoFromRequest(input),
    })),
    withdrawOrder: vi.fn(async (): Promise<WithdrawOrderResponse> => {
      throw new Error('withdraw fixture not configured');
    }),
    ...overrides,
  };
}

function placeAction(overrides: Partial<HybridPlaceOrderAction> = {}): HybridPlaceOrderAction {
  return {
    marketId: '1',
    conditionId: CONDITION,
    tokenId: YES_TOKEN.toString(),
    complementTokenId: NO_TOKEN.toString(),
    outcome: 'YES',
    side: 'BID',
    priceRaw: 570_001n,
    sizeRaw: 2_500_001n,
    ...overrides,
  };
}

async function signedOrder(
  maker: LocalAccount,
  side: 0 | 1 = Side.SELL,
): Promise<OffchainOrder> {
  const signed = await signCtfExchangeOrder(
    maker,
    buildCtfExchangeOrder({
      salt: 11n,
      maker: maker.address,
      tokenId: YES_TOKEN,
      side,
      priceRaw: 500_000n,
      sizeRaw: 500_000n,
      expiration: 2_000_000_000n,
      nonce: 7n,
    }),
  );
  return {
    orderHash: hashCtfExchangeOrder(signed),
    marketId: '1',
    conditionId: CONDITION,
    tokenId: YES_TOKEN.toString(),
    outcome: 'YES',
    maker: maker.address,
    side: side === Side.BUY ? 'BID' : 'ASK',
    priceRaw: '500000',
    sizeRaw: '500000',
    filledRaw: '0',
    remainingRaw: '500000',
    status: 'OPEN',
    fillable: true,
    unfillableReason: null,
    signedOrder: ctfExchangeOrderToWire(signed),
    createdAt: 1_900_000_000,
    updatedAt: 1_900_000_000,
  };
}

function executor(
  signer: LocalAccount,
  chain = chainClient(),
  writes = writeClient(),
  rest = restClient({
    verifySiwe: vi.fn(async () => ({
      session: {
        authenticated: true,
        address: signer.address,
        expiresAt: '2030-01-08T00:00:00.000Z',
      },
      sessionCookie: SESSION_COOKIE,
    })),
  }),
) {
  return {
    executor: new ArcHybridTraderExecutor(signer, chain, writes, rest, {
      orderLifetimeSeconds: 300n,
    }),
    chain,
    writes,
    rest,
  };
}

describe('Hybrid ingest rejection policy', () => {
  it('classifies every shared rejection code exhaustively', () => {
    expect(Object.keys(ORDER_INGEST_REJECTION_POLICY).sort()).toEqual(
      [...ALL_REJECTIONS].sort(),
    );
    expect(
      ALL_REJECTIONS.filter(
        (code) => ORDER_INGEST_REJECTION_POLICY[code].classification === 'retryable',
      ),
    ).toEqual(['WRONG_NONCE', 'MISSING_APPROVAL', 'CHAIN_READ_FAILED']);
    for (const code of ALL_REJECTIONS) {
      expect(ORDER_INGEST_REJECTION_POLICY[code].reason.length).toBeGreaterThan(10);
    }
  });

  it('never posts the same economic order again after a permanent rejection', async () => {
    const signer = account();
    const postOrder = vi.fn(async () => {
      throw new OrderIngestRejectedError(
        422,
        'BAD_SIGNATURE',
        'signature did not recover',
      );
    });
    const setup = executor(signer, chainClient(), writeClient(), restClient({ postOrder }));

    await expect(setup.executor.placeOrder(placeAction())).rejects.toThrow(
      /BAD_SIGNATURE.*permanent/u,
    );
    await expect(setup.executor.placeOrder(placeAction())).rejects.toThrow(
      /suppressed/u,
    );
    expect(postOrder).toHaveBeenCalledOnce();
  });

  it('re-reads makerNonce, rebuilds, and retries WRONG_NONCE exactly once', async () => {
    const signer = account();
    const posted: IngestOrderRequest[] = [];
    const postOrder = vi.fn(async (input: IngestOrderRequest) => {
      posted.push(input);
      if (posted.length === 1) {
        throw new OrderIngestRejectedError(422, 'WRONG_NONCE', 'nonce changed');
      }
      return { order: dtoFromRequest(input) };
    });
    const setup = executor(
      signer,
      chainClient({ makerNonces: [7n, 8n] }),
      writeClient(),
      restClient({ postOrder }),
    );

    const result = await setup.executor.placeOrder(placeAction());

    expect(posted.map(({ order }) => order.nonceRaw)).toEqual(['7', '8']);
    expect(result.rejections).toEqual([
      expect.objectContaining({ code: 'WRONG_NONCE', classification: 'retryable' }),
    ]);
    expect(postOrder).toHaveBeenCalledTimes(2);
  });
});

describe('Hybrid order construction and approvals', () => {
  it('uses the P1 amount rounding in the signed wire order', async () => {
    const signer = account();
    const posted: IngestOrderRequest[] = [];
    const setup = executor(
      signer,
      chainClient(),
      writeClient(),
      restClient({
        postOrder: vi.fn(async (input) => {
          posted.push(input);
          return { order: dtoFromRequest(input) };
        }),
      }),
    );

    await setup.executor.placeOrder(placeAction());

    expect(posted[0]?.order).toMatchObject({
      makerAmountRaw: '1425003',
      takerAmountRaw: '2500001',
      side: Side.BUY,
    });
  });

  it('does not propagate a transport exception containing the full signed POST body', async () => {
    const signer = account();
    const setup = executor(
      signer,
      chainClient(),
      writeClient(),
      restClient({
        postOrder: vi.fn(async (input) => {
          throw new Error(JSON.stringify(input));
        }),
      }),
    );

    const error = await setup.executor
      .placeOrder(placeAction())
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('before the operator returned a typed response');
    expect(String(error)).not.toContain('signature');
    expect(String(error)).not.toContain('makerAmountRaw');
  });

  it('skips an existing approval and sends an exact collateral approval when missing', async () => {
    const signer = account();
    const granted = executor(
      signer,
      chainClient({ allowance: 10_000_000n }),
      writeClient(),
    );
    await granted.executor.placeOrder(placeAction());
    expect(granted.writes.send).not.toHaveBeenCalled();

    let allowanceReads = 0;
    const missingChain = chainClient({ allowance: 0n });
    missingChain.readContract.mockImplementation(async ({ functionName }) => {
      switch (functionName) {
        case 'makerNonce':
          return 7n;
        case 'registry':
          return [NO_TOKEN, CONDITION] as const;
        case 'payoutDenominator':
          return 0n;
        case 'balanceOf':
          return 10_000_000n;
        case 'allowance':
          allowanceReads += 1;
          return allowanceReads === 1 ? 0n : 1_425_003n;
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    });
    const missing = executor(signer, missingChain, writeClient());

    await missing.executor.placeOrder(placeAction());

    expect(missing.writes.send).toHaveBeenCalledWith(
      buildCtfExchangeCollateralApprovalTx({ amountRaw: 1_425_003n }),
    );
    expect(missing.writes.send).toHaveBeenCalledOnce();
  });

  it('reads and grants the exchange CTF approval only when an ASK needs it', async () => {
    const signer = account();
    let approvalReads = 0;
    const chain = chainClient();
    chain.readContract.mockImplementation(async ({ functionName }) => {
      switch (functionName) {
        case 'makerNonce':
          return 7n;
        case 'registry':
          return [NO_TOKEN, CONDITION] as const;
        case 'payoutDenominator':
          return 0n;
        case 'balanceOf':
          return 10_000_000n;
        case 'isApprovedForAll':
          approvalReads += 1;
          return approvalReads > 1;
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    });
    const setup = executor(signer, chain, writeClient());

    await setup.executor.placeOrder(placeAction({ side: 'ASK' }));

    expect(setup.writes.send).toHaveBeenCalledWith(
      buildCtfExchangeApprovalForAllTx(),
    );
    expect(setup.writes.send).toHaveBeenCalledOnce();
  });
});

describe('Hybrid fill, withdraw, cancel, and session handling', () => {
  it('keeps free withdrawal distinct from authoritative per-order cancel calldata', async () => {
    const signer = account();
    const ownOrder = await signedOrder(signer);
    const cancelTx = buildCtfExchangeCancelOrderTx({
      order: ctfExchangeOrderFromWire(ownOrder.signedOrder),
    });
    const withdrawal: WithdrawOrderResponse = {
      order: { ...ownOrder, status: 'WITHDRAWN', fillable: false },
      offchainWithdrawalIsOnchainCancellation: false,
      signedOrderMayRemainValidOnchain: true,
      warning: 'Signature remains valid until expiry or on-chain cancel.',
      authoritativeCancelOrderTx: {
        to: cancelTx.to,
        data: cancelTx.data,
        valueRaw: cancelTx.value.toString(),
      },
    };
    const withdrawOrder = vi.fn(async () => withdrawal);
    const setup = executor(
      signer,
      chainClient(),
      writeClient(),
      restClient({
        verifySiwe: vi.fn(async () => ({
          session: {
            authenticated: true,
            address: signer.address,
            expiresAt: '2030-01-08T00:00:00.000Z',
          },
          sessionCookie: SESSION_COOKIE,
        })),
        withdrawOrder,
      }),
    );

    await expect(setup.executor.withdrawOrder({ order: ownOrder })).resolves.toBe(
      withdrawal,
    );
    expect(setup.writes.send).not.toHaveBeenCalled();

    await setup.executor.cancelOrder({ order: ownOrder });
    expect(setup.writes.send).toHaveBeenCalledWith(cancelTx);
    const calledData = setup.writes.send.mock.calls.map(([tx]) =>
      decodeFunctionData({ abi: ctfExchangeAbi, data: tx.data }).functionName,
    );
    expect(calledData).toEqual(['cancelOrder']);
    expect(calledData).not.toContain('cancelAll');
  });

  it('re-reads fresh order state and uses fillOrder calldata after approval is already granted', async () => {
    const taker = account();
    const maker = account();
    const resting = await signedOrder(maker, Side.SELL);
    const setup = executor(taker);
    const action: HybridFillOrderAction = {
      marketId: '1',
      conditionId: CONDITION,
      tokenId: YES_TOKEN.toString(),
      complementTokenId: NO_TOKEN.toString(),
      outcome: 'YES',
      restingSide: 'ASK',
      order: resting,
      expectedPriceRaw: 500_000n,
      fillSizeRaw: 100_000n,
    };

    await setup.executor.fillOrder(action);

    expect(setup.chain.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'makerNonce', args: [maker.address] }),
    );
    expect(setup.chain.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'filledAmount', args: [resting.orderHash] }),
    );
    expect(setup.writes.send).toHaveBeenCalledOnce();
    expect(
      decodeFunctionData({
        abi: ctfExchangeAbi,
        data: setup.writes.send.mock.calls[0]?.[0].data as Hex,
      }),
    ).toMatchObject({ functionName: 'fillOrder' });
  });

  it('approves only the exact collateral needed by a Hybrid ASK fill, then re-reads before filling', async () => {
    const taker = account();
    const maker = account();
    const resting = await signedOrder(maker, Side.SELL);
    let allowanceReads = 0;
    const chain = chainClient();
    chain.readContract.mockImplementation(async ({ functionName }) => {
      switch (functionName) {
        case 'makerNonce':
          return 7n;
        case 'registry':
          return [NO_TOKEN, CONDITION] as const;
        case 'payoutDenominator':
          return 0n;
        case 'cancelledOrders':
          return false;
        case 'filledAmount':
          return 0n;
        case 'balanceOf':
          return 10_000_000n;
        case 'isApprovedForAll':
          return true;
        case 'allowance':
          allowanceReads += 1;
          return allowanceReads === 1 ? 0n : 50_000n;
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    });
    const setup = executor(taker, chain, writeClient());
    const action: HybridFillOrderAction = {
      marketId: '1',
      conditionId: CONDITION,
      tokenId: YES_TOKEN.toString(),
      complementTokenId: NO_TOKEN.toString(),
      outcome: 'YES',
      restingSide: 'ASK',
      order: resting,
      expectedPriceRaw: 500_000n,
      fillSizeRaw: 100_000n,
    };

    await setup.executor.fillOrder(action);

    expect(setup.writes.send.mock.calls[0]?.[0]).toEqual(
      buildCtfExchangeCollateralApprovalTx({ amountRaw: 50_000n }),
    );
    expect(
      decodeFunctionData({
        abi: ctfExchangeAbi,
        data: setup.writes.send.mock.calls[1]?.[0].data as Hex,
      }).functionName,
    ).toBe('fillOrder');
    expect(allowanceReads).toBe(2);
  });

  it('reauthenticates once when a session-gated order read returns 401', async () => {
    const signer = account();
    const getMakerOrders = vi
      .fn<(cookie: string) => Promise<MakerOrdersResponse>>()
      .mockRejectedValueOnce(new PredexRestError(401, 'expired'))
      .mockResolvedValueOnce({
        orders: [],
        offchainWithdrawalIsOnchainCancellation: false,
        warning: 'Withdrawal is off-chain only.',
      });
    const verifySiwe = vi.fn(async () => ({
      session: {
        authenticated: true as const,
        address: signer.address,
        expiresAt: '2030-01-08T00:00:00.000Z',
      },
      sessionCookie: SESSION_COOKIE,
    }));
    const setup = executor(
      signer,
      chainClient(),
      writeClient(),
      restClient({ getMakerOrders, verifySiwe }),
    );

    await expect(setup.executor.getMakerOrders()).resolves.toMatchObject({
      orders: [],
    });
    expect(getMakerOrders).toHaveBeenCalledTimes(2);
    expect(verifySiwe).toHaveBeenCalledTimes(2);
  });
});
