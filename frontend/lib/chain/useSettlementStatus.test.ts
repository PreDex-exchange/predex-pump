import type { Market } from '@predex-pump/shared/domain';
import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  type Abi,
} from 'viem';
import { describe, expect, it } from 'vitest';

import { ADDRESSES } from '@/lib/shared/addresses';

import {
  committeeOracleAbi,
  conditionalTokensAbi,
  incubatorLmsrAbi,
  incubatorRegistryAbi,
} from './contracts';
import { createArcPublicClient } from './client';
import { readSettlementStatus } from './useSettlementStatus';

const ACCOUNT = `0x${'c'.repeat(40)}` as const;
const CREATOR = `0x${'a'.repeat(40)}` as const;

const market: Market = {
  id: '91',
  creator: CREATOR,
  question: 'Are settlement reads batched?',
  phase: 'Graduated',
  conditionId: `0x${'2'.repeat(64)}`,
  questionId: `0x${'3'.repeat(64)}`,
  yesTokenId: '201',
  noTokenId: '202',
  seedRaw: '1000000',
  yesPriceRaw: '520000',
  noPriceRaw: '480000',
  graduationActivityRaw: '25000000',
  bookAddress: `0x${'b'.repeat(40)}`,
  frozenYesPriceRaw: '520000',
  handoffSizeRaw: '5000000',
  tradeCount: 1,
  volumeRaw: '50000',
  params: {
    seedFloorRaw: '1000000',
    seedCapRaw: '50000000',
    fCapRaw: '100000000',
    graduationMoneyInThresholdRaw: '25000000',
    graduationTollRaw: '2000000',
    inventoryTargetRaw: '5000000',
    protocolFeeBps: 100,
    depthFeeBps: 50,
    tradingWindowSeconds: 86400,
    minimumTimeOpenSeconds: 3600,
    minimumTickSizeRaw: '1000',
  },
  createdAt: 1_784_800_000,
  tradingEndsAt: 1_784_886_400,
  graduatedAt: 1_784_803_600,
  resolvedAt: 1_784_918_616,
};

const multicall3Abi = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);

function encodedResult(abi: Abi, functionName: string, result: unknown) {
  return encodeFunctionResult({
    abi,
    functionName,
    result,
  });
}

function blockResult() {
  return {
    baseFeePerGas: '0x0',
    difficulty: '0x0',
    extraData: '0x',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    hash: `0x${'1'.repeat(64)}`,
    logsBloom: `0x${'0'.repeat(512)}`,
    miner: `0x${'0'.repeat(40)}`,
    mixHash: `0x${'0'.repeat(64)}`,
    nonce: '0x0000000000000000',
    number: '0x3300000',
    parentHash: `0x${'2'.repeat(64)}`,
    receiptsRoot: `0x${'3'.repeat(64)}`,
    sha3Uncles: `0x${'4'.repeat(64)}`,
    size: '0x1',
    stateRoot: `0x${'5'.repeat(64)}`,
    timestamp: '0x6a2a690c',
    totalDifficulty: '0x0',
    transactions: [],
    transactionsRoot: `0x${'6'.repeat(64)}`,
    uncles: [],
  };
}

describe('settlement RPC aggregation', () => {
  it('uses one Multicall3 request plus one block request and no log scan', async () => {
    const ammState = {
      qYesRaw: 0n,
      qNoRaw: 0n,
      inventoryYesRaw: 0n,
      inventoryNoRaw: 0n,
      fundingCommittedRaw: 0n,
      bCurrentWad: 0n,
      totalBuyBaseRaw: 0n,
      totalSellBaseRaw: 0n,
      netBaseCollectedRaw: 0n,
      protocolFeesAccruedRaw: 0n,
      depthCommittedRaw: 0n,
      nonCreatorBuyBaseInRaw: 0n,
      nonCreatorSellBaseOutRaw: 0n,
      nonCreatorDepthCommittedRaw: 0n,
      nonCreatorNetBaseFlowRaw: 0n,
      graduationHandoffRaw: 0n,
      halted: false,
      pausedNewTrades: true,
      resolved: true,
      closedOut: false,
      payoutYes: 1n,
      payoutNo: 0n,
      payoutDenominator: 1n,
      invalidUniform: false,
    };
    function returnForCall(
      target: `0x${string}`,
      callData: `0x${string}`,
    ) {
      if (target.toLowerCase() === ADDRESSES.registry.toLowerCase()) {
        return encodedResult(incubatorRegistryAbi, 'marketLifecycle', [
          CREATOR,
          1,
          3,
          false,
          market.createdAt,
          market.createdAt,
          market.graduatedAt,
          0,
          0,
        ]);
      }
      if (target.toLowerCase() === ADDRESSES.lmsr.toLowerCase()) {
        const decoded = decodeFunctionData({
          abi: incubatorLmsrAbi,
          data: callData,
        });
        if (decoded.functionName === 'ammState') {
          return encodedResult(incubatorLmsrAbi, 'ammState', ammState);
        }
        if (decoded.functionName === 'terminalAccounting') {
          return encodedResult(
            incubatorLmsrAbi,
            'terminalAccounting',
            [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0],
          );
        }
        return encodedResult(incubatorLmsrAbi, decoded.functionName, 0n);
      }
      if (target.toLowerCase() === ADDRESSES.oracle.toLowerCase()) {
        const decoded = decodeFunctionData({
          abi: committeeOracleAbi,
          data: callData,
        });
        return encodedResult(
          committeeOracleAbi,
          decoded.functionName,
          decoded.functionName === 'questionThreshold' ? 1n : false,
        );
      }
      const decoded = decodeFunctionData({
        abi: conditionalTokensAbi,
        data: callData,
      });
      if (decoded.functionName === 'payoutDenominator') {
        return encodedResult(
          conditionalTokensAbi,
          decoded.functionName,
          1n,
        );
      }
      const secondArgument = decoded.args?.[1];
      const value =
        decoded.functionName === 'payoutNumerators'
          ? secondArgument === 0n
            ? 1n
            : 0n
          : secondArgument === 201n
            ? 1_000_000n
            : 0n;
      return encodedResult(conditionalTokensAbi, decoded.functionName, value);
    }
    const methods: string[] = [];
    const client = createArcPublicClient(
      custom({
        async request({ method, params }) {
          methods.push(method);
          if (method === 'eth_call') {
            const transaction = (
              params as readonly [{ data: `0x${string}` }]
            )[0];
            const aggregate = decodeFunctionData({
              abi: multicall3Abi,
              data: transaction.data,
            });
            const calls = aggregate.args[0];
            return encodeFunctionResult({
              abi: multicall3Abi,
              functionName: 'aggregate3',
              result: calls.map((call) => ({
                success: true,
                returnData: returnForCall(call.target, call.callData),
              })),
            });
          }
          if (method === 'eth_getBlockByNumber') return blockResult();
          throw new Error(`Unexpected RPC method ${method}`);
        },
      }),
    );

    const status = await readSettlementStatus(
      market,
      ACCOUNT,
      { protocolSweepCompleted: false, protocolSweptRaw: '0' },
      client,
    );

    expect(status.outcome).toBe('YES');
    expect(status.yesRedeemableRaw).toBe(1_000_000n);
    expect(methods).toHaveLength(2);
    expect(methods).toEqual(
      expect.arrayContaining(['eth_call', 'eth_getBlockByNumber']),
    );
    expect(methods).not.toContain('eth_getLogs');
  });
});
