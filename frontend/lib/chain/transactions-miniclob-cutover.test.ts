import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

import { ADDRESSES, ARC } from '@/lib/shared/addresses';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const CONDITION = `0x${'2'.repeat(64)}` as Hex;
const TX_HASH = `0x${'3'.repeat(64)}` as Hex;

const mocks = vi.hoisted(() => ({
  getAccount: vi.fn(),
  readContract: vi.fn(),
  sendTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));

vi.mock('./client', () => ({
  arcPublicClient: { readContract: mocks.readContract },
}));

vi.mock('./config', () => ({ wagmiConfig: {} }));

vi.mock('./tx-journal', () => ({
  recordPendingArcTransaction: vi.fn(),
  removePendingArcTransaction: vi.fn(),
}));

vi.mock('wagmi/actions', () => ({
  getAccount: mocks.getAccount,
  getWalletClient: vi.fn(),
  sendTransaction: mocks.sendTransaction,
  signMessage: vi.fn(),
  waitForTransactionReceipt: mocks.waitForTransactionReceipt,
}));

import {
  cancelOrderOnArc,
  fillOrderOnArc,
  placeOrderOnArc,
} from './transactions';

function order() {
  return {
    maker: ACCOUNT,
    conditionId: CONDITION,
    tokenId: 101n,
    side: 1,
    priceRawPerToken: 600_000n,
    sizeRaw: 1_000_000n,
    filledRaw: 0n,
    open: true,
  };
}

describe('MiniCLOB cutover transaction preflight', () => {
  beforeEach(() => {
    mocks.getAccount.mockReset().mockReturnValue({
      isConnected: true,
      address: ACCOUNT,
      chainId: ARC.chainId,
    });
    mocks.readContract.mockReset().mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === 'marketLifecycle') {
          return [ACCOUNT, 2, 3, false, 0, 0, 0, 0, 0];
        }
        if (functionName === 'tokenBinding') {
          return [
            ADDRESSES.usdc,
            ADDRESSES.ctf,
            ADDRESSES.oracle,
            CONDITION,
            CONDITION,
            101n,
            102n,
          ];
        }
        if (functionName === 'getOrder') return order();
        if (functionName === 'minimumFillRaw') return 1n;
        if (functionName === 'conditionStale') return true;
        if (functionName === 'isConditionPrepared') return true;
        if (functionName === 'payoutDenominator') return 0n;
        throw new Error(`Unexpected read ${functionName}`);
      },
    );
    mocks.sendTransaction.mockReset().mockResolvedValue(TX_HASH);
    mocks.waitForTransactionReceipt.mockReset().mockResolvedValue({
      status: 'success',
      transactionHash: TX_HASH,
      logs: [],
    });
  });

  it('rejects stale placement before any approval or order transaction', async () => {
    await expect(
      placeOrderOnArc({
        account: ACCOUNT,
        marketId: 1n,
        outcome: 'YES',
        side: 'ASK',
        priceRaw: 600_000n,
        sizeRaw: 1_000_000n,
        minimumTickSizeRaw: 1_000n,
        report: vi.fn(),
      }),
    ).rejects.toThrow('This on-chain book has closed');
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
    expect(
      mocks.readContract.mock.calls.map(([request]) => request.functionName),
    ).not.toContain('isApprovedForAll');
  });

  it('rejects a stale fill before any counter-asset approval or fill', async () => {
    await expect(
      fillOrderOnArc({
        account: ACCOUNT,
        orderId: 20n,
        fillSizeRaw: 1_000_000n,
        report: vi.fn(),
      }),
    ).rejects.toThrow('This on-chain book has closed');
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
    expect(
      mocks.readContract.mock.calls.map(([request]) => request.functionName),
    ).not.toContain('allowance');
  });

  it('keeps maker cancellation available without consulting stale state', async () => {
    await expect(
      cancelOrderOnArc({
        account: ACCOUNT,
        orderId: 20n,
        report: vi.fn(),
      }),
    ).resolves.toMatchObject({ orderId: 20n, refundRaw: 1_000_000n });
    expect(mocks.sendTransaction).toHaveBeenCalledOnce();
    expect(
      mocks.readContract.mock.calls.map(([request]) => request.functionName),
    ).toEqual(['getOrder']);
  });
});
