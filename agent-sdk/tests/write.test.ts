import { buildCreateMarketTx } from '@predex-pump/shared/tx';
import { describe, expect, it, vi } from 'vitest';

import {
  arcAgentChain,
  PredexWriteClient,
  type AgentWalletClient,
} from '../src/index.js';

describe('PredexWriteClient.createMarket', () => {
  it('broadcasts calldata from the shared create-market builder', async () => {
    const hash = `0x${'ab'.repeat(32)}` as const;
    const account = {
      address: `0x${'12'.repeat(20)}`,
    };
    const sendTransaction = vi.fn(async () => hash);
    const walletClient = {
      account,
      sendTransaction,
    } as unknown as AgentWalletClient;
    const input = {
      ancillaryData: '0x7175657374696f6e00' as const,
      seedRaw: 1_000_000n,
      openingFeeRaw: 100_000n,
      tradingWindowSeconds: 86_400n,
      metadataHash: `0x${'34'.repeat(32)}` as const,
    };

    await expect(
      new PredexWriteClient(walletClient).createMarket(input),
    ).resolves.toBe(hash);
    expect(sendTransaction).toHaveBeenCalledWith({
      account,
      chain: arcAgentChain,
      ...buildCreateMarketTx(input),
    });
  });
});
