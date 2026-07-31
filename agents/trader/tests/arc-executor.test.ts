import { ADDRESSES } from '@predex-pump/shared';
import type { Account, Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import {
  ArcTraderExecutor,
  type TraderChainClient,
  type TraderWriteClient,
} from '../src/arc-executor.js';
import {
  BroadcastUncertainError,
  type FillOrderAction,
  type PlaceOrderAction,
} from '../src/agent.js';

const ACCOUNT = {
  address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
} as unknown as Account;
const MAKER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address;
const CONDITION = `0x${'1'.repeat(64)}` as Hex;
const YES_TOKEN = 101n;
const TX_HASH = `0x${'2'.repeat(64)}` as Hex;

interface ChainOptions {
  lifecycleState?: number;
  paused?: boolean;
  payoutDenominator?: bigint;
  minimumFillRaw?: bigint;
  orderOpen?: boolean;
  receiptError?: string;
}

function chainClient(options: ChainOptions = {}): TraderChainClient {
  return {
    async readContract({ functionName }) {
      switch (functionName) {
        case 'marketLifecycle':
          return [MAKER, 2, options.lifecycleState ?? 3, options.paused ?? false];
        case 'tokenBinding':
          return [
            ADDRESSES.usdc,
            ADDRESSES.ctf,
            ADDRESSES.oracle,
            `0x${'3'.repeat(64)}`,
            CONDITION,
            YES_TOKEN,
            102n,
          ];
        case 'isConditionPrepared':
          return true;
        case 'payoutDenominator':
          return options.payoutDenominator ?? 0n;
        case 'balanceOf':
        case 'allowance':
          return 10_000_000n;
        case 'isApprovedForAll':
          return true;
        case 'getOrder':
          return {
            maker: MAKER,
            conditionId: CONDITION,
            tokenId: YES_TOKEN,
            side: 1,
            priceRawPerToken: 500_000n,
            sizeRaw: 1_000_000n,
            filledRaw: 0n,
            open: options.orderOpen ?? true,
          };
        case 'minimumFillRaw':
          return options.minimumFillRaw ?? 1n;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    async waitForTransactionReceipt() {
      if (options.receiptError !== undefined) {
        throw new Error(options.receiptError);
      }
      return { status: 'success', logs: [] };
    },
  };
}

function writeClient(): TraderWriteClient & {
  placeOrder: ReturnType<typeof vi.fn>;
  fillOrder: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
} {
  return {
    approveCollateral: vi.fn(async () => TX_HASH),
    approveCtfOperator: vi.fn(async () => TX_HASH),
    placeOrder: vi.fn(async () => TX_HASH),
    fillOrder: vi.fn(async () => TX_HASH),
    cancelOrder: vi.fn(async () => TX_HASH),
  } as unknown as ReturnType<typeof writeClient>;
}

function placeAction(): PlaceOrderAction {
  return {
    marketId: '1',
    conditionId: CONDITION,
    tokenId: YES_TOKEN.toString(),
    outcome: 'YES',
    side: 'BID',
    priceRaw: 580_000n,
    sizeRaw: 100_000n,
  };
}

function fillAction(): FillOrderAction {
  return {
    marketId: '1',
    conditionId: CONDITION,
    tokenId: YES_TOKEN.toString(),
    outcome: 'YES',
    restingSide: 'ASK',
    orderId: '7',
    expectedPriceRaw: 500_000n,
    fillSizeRaw: 100_000n,
  };
}

describe('ArcTraderExecutor fresh-state gates', () => {
  it('refuses a place when fresh Arc lifecycle is not Graduated', async () => {
    const writes = writeClient();
    const executor = new ArcTraderExecutor(
      ACCOUNT,
      chainClient({ lifecycleState: 2 }),
      writes,
    );

    await expect(executor.placeOrder(placeAction())).rejects.toThrow(
      /not an unpaused Graduated market/u,
    );
    expect(writes.placeOrder).not.toHaveBeenCalled();
  });

  it('refuses a fill when fresh CTF state says the condition resolved', async () => {
    const writes = writeClient();
    const executor = new ArcTraderExecutor(
      ACCOUNT,
      chainClient({ payoutDenominator: 1n }),
      writes,
    );

    await expect(executor.fillOrder(fillAction())).rejects.toThrow(/resolved/u);
    expect(writes.fillOrder).not.toHaveBeenCalled();
  });

  it('refuses rather than resizing below the live minimum fill', async () => {
    const writes = writeClient();
    const executor = new ArcTraderExecutor(
      ACCOUNT,
      chainClient({ minimumFillRaw: 200_000n }),
      writes,
    );

    await expect(executor.fillOrder(fillAction())).rejects.toThrow(
      /below fresh minimum 200000/u,
    );
    expect(writes.fillOrder).not.toHaveBeenCalled();
  });

  it('broadcasts only after all fresh place gates pass', async () => {
    const writes = writeClient();
    const executor = new ArcTraderExecutor(ACCOUNT, chainClient(), writes);

    await expect(executor.placeOrder(placeAction())).resolves.toEqual({
      txHash: TX_HASH,
      orderId: `unindexed:${TX_HASH}`,
    });
    expect(writes.placeOrder).toHaveBeenCalledWith({
      conditionId: CONDITION,
      tokenId: YES_TOKEN,
      side: 'BID',
      priceRaw: 580_000n,
      sizeRaw: 100_000n,
    });
  });

  it('marks a submitted action uncertain when its receipt RPC fails', async () => {
    const writes = writeClient();
    const executor = new ArcTraderExecutor(
      ACCOUNT,
      chainClient({ receiptError: 'receipt timeout' }),
      writes,
    );

    const error = await executor.placeOrder(placeAction()).catch((reason: unknown) =>
      reason,
    );

    expect(error).toBeInstanceOf(BroadcastUncertainError);
    expect(error).toMatchObject({
      txHash: TX_HASH,
      actionMayHaveCommitted: true,
    });
  });
});
