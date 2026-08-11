import { ADDRESSES } from '@predex-pump/shared';

import type {
  ChainStateReader,
  ChainStateSnapshot,
} from '../src/indexer/chain-state-bootstrap.js';

export const COMMITTEE_SIGNERS = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
] as const;

export function chainStateSnapshot(blockNumber: number): ChainStateSnapshot {
  return {
    blockNumber,
    registry: {
      collateralAddress: ADDRESSES.usdc.toLowerCase(),
      collateralDecimals: 6,
      ctfAddress: ADDRESSES.ctf.toLowerCase(),
      oracleAddress: ADDRESSES.oracle.toLowerCase(),
      lmsrAddress: ADDRESSES.lmsr.toLowerCase(),
      miniClobAddress: ADDRESSES.miniClob.toLowerCase(),
      defaultMarketTypeVersion: 2,
      params: {
        openingFeeRaw: '0',
        seedFloorRaw: '1000000',
        seedCapRaw: '5000000',
        fCapRaw: '100000000',
        singleTopUpCapRaw: '5000000',
        graduationMoneyInThresholdRaw: '25000000',
        graduationTollRaw: '100000',
        inventoryTargetRaw: '5000000',
        inventoryLowRaw: '2500000',
        inventoryHighRaw: '7500000',
        freeCollateralBufferRaw: '1000000',
        defaultTradingWindowSeconds: 86_400,
        minTradingWindowSeconds: 300,
        maxTradingWindowSeconds: 7_776_000,
        minimumTimeOpenSeconds: 300,
        protocolFeeBps: 20,
        depthFeeBps: 10,
      },
    },
    committee: {
      ctfAddress: ADDRESSES.ctf.toLowerCase(),
      threshold: 2,
      signers: [...COMMITTEE_SIGNERS],
    },
    marketTypes: [
      {
        version: 1,
        lmsrAddress: ADDRESSES.lmsr.toLowerCase(),
        configHash: `0x${'1'.repeat(64)}`,
      },
      {
        version: 2,
        lmsrAddress: ADDRESSES.lmsr.toLowerCase(),
        configHash: `0x${'2'.repeat(64)}`,
      },
    ],
    rpcRequestCount: 2,
  };
}

export const testChainStateReader: ChainStateReader = {
  readChainState: async (blockNumber) => chainStateSnapshot(blockNumber),
};
