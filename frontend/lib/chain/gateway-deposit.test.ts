import {
  buildCircleGatewayApprovalTx,
  buildCircleGatewayDepositTx,
  CIRCLE_GATEWAY_DEPOSIT_GAS_LIMIT,
} from '@predex-pump/shared/tx';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { depositToCircleGatewayOnArc } from './transactions';

const mocks = vi.hoisted(() => ({
  address: `0x${'12'.repeat(20)}` as const,
  approvalHash: `0x${'ab'.repeat(32)}` as const,
  depositHash: `0x${'cd'.repeat(32)}` as const,
  getAccount: vi.fn(),
  sendTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  readContract: vi.fn(),
  recordPendingArcTransaction: vi.fn(),
  removePendingArcTransaction: vi.fn(),
}));

vi.mock('wagmi/actions', () => ({
  getAccount: mocks.getAccount,
  sendTransaction: mocks.sendTransaction,
  signMessage: vi.fn(),
  waitForTransactionReceipt: mocks.waitForTransactionReceipt,
}));

vi.mock('./config', () => ({ wagmiConfig: { test: true } }));

vi.mock('./client', () => ({
  arcPublicClient: { readContract: mocks.readContract },
  readSettlementEventState: vi.fn(),
}));

vi.mock('./tx-journal', () => ({
  recordPendingArcTransaction: mocks.recordPendingArcTransaction,
  removePendingArcTransaction: mocks.removePendingArcTransaction,
}));

beforeEach(() => {
  mocks.getAccount.mockReset();
  mocks.getAccount.mockReturnValue({
    address: mocks.address,
    chainId: 5_042_002,
    isConnected: true,
  });
  mocks.readContract.mockReset();
  mocks.readContract.mockResolvedValue(10_000_000n);
  mocks.sendTransaction.mockReset();
  mocks.sendTransaction
    .mockResolvedValueOnce(mocks.approvalHash)
    .mockResolvedValueOnce(mocks.depositHash);
  mocks.waitForTransactionReceipt.mockReset();
  mocks.waitForTransactionReceipt.mockImplementation(
    async (_config: unknown, input: { hash: `0x${string}` }) => {
      expect(mocks.recordPendingArcTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ account: mocks.address, hash: input.hash }),
      );
      return {
        status: 'success',
        transactionHash: input.hash,
        logs: [],
      };
    },
  );
  mocks.recordPendingArcTransaction.mockReset();
  mocks.removePendingArcTransaction.mockReset();
});

describe('connected-wallet Circle Gateway deposit', () => {
  it('sends approve then SDK-derived deposit calldata through wagmi', async () => {
    const report = vi.fn();
    const result = await depositToCircleGatewayOnArc({
      account: mocks.address,
      amountRaw: 1_000_000n,
      report,
    });

    expect(mocks.sendTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.recordPendingArcTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.removePendingArcTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.sendTransaction.mock.calls[0]?.[1]).toMatchObject({
      ...buildCircleGatewayApprovalTx(1_000_000n),
      chainId: 5_042_002,
    });
    expect(mocks.sendTransaction.mock.calls[1]?.[1]).toMatchObject({
      ...buildCircleGatewayDepositTx(1_000_000n),
      chainId: 5_042_002,
      gas: CIRCLE_GATEWAY_DEPOSIT_GAS_LIMIT,
    });
    expect(result).toEqual({
      approvalTxHash: mocks.approvalHash,
      depositTxHash: mocks.depositHash,
    });
    expect(report.mock.calls.map((call) => call[0].message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Step 1 of 2'),
        expect.stringContaining('Step 2 of 2'),
      ]),
    );
  });

  it('retains a submitted hash when Arc receipt lookup is temporarily unavailable', async () => {
    mocks.waitForTransactionReceipt.mockRejectedValueOnce(
      new Error('temporary transport failure'),
    );

    await expect(
      depositToCircleGatewayOnArc({
        account: mocks.address,
        amountRaw: 1_000_000n,
        report: vi.fn(),
      }),
    ).rejects.toThrow('temporary transport failure');

    expect(mocks.sendTransaction).toHaveBeenCalledOnce();
    expect(mocks.recordPendingArcTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        account: mocks.address,
        hash: mocks.approvalHash,
      }),
    );
    expect(mocks.removePendingArcTransaction).not.toHaveBeenCalled();
  });
});
