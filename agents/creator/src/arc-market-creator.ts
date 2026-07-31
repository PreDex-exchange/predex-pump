import {
  arcAgentChain,
  createWriteClient,
  type PredexWriteClient,
} from '@predex-pump/agent-sdk';
import { ADDRESSES, ARC } from '@predex-pump/shared';
import registryAbiJson from '@predex-pump/shared/abis/IncubatorRegistry.json' with {
  type: 'json',
};
import {
  buildMarketMetadata,
  collateralErc20Abi,
} from '@predex-pump/shared/tx';
import {
  createPublicClient,
  decodeEventLog,
  http,
  type Abi,
  type Account,
  type PublicClient,
} from 'viem';

import type {
  MarketCreationInput,
  MarketCreationResult,
  MarketCreator,
} from './agent.js';

const registryAbi = registryAbiJson as Abi;

interface DefaultMarketParams {
  openingFeeRaw: bigint;
  seedFloorRaw: bigint;
  seedCapRaw: bigint;
  minTradingWindowSeconds: number;
  maxTradingWindowSeconds: number;
}

type ArcPublicClient = PublicClient<
  ReturnType<typeof http>,
  typeof arcAgentChain
>;

function marketIdFromReceipt(
  receipt: Awaited<ReturnType<ArcPublicClient['waitForTransactionReceipt']>>,
): string {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ADDRESSES.registry.toLowerCase()) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: registryAbi,
        data: log.data,
        topics: log.topics,
        strict: false,
      });
      if (decoded.eventName !== 'MarketCreated') continue;
      const args = decoded.args as unknown as Record<string, unknown>;
      if (typeof args.marketId === 'bigint') return args.marketId.toString();
    } catch {
      // The registry can emit unrelated events in the same transaction.
    }
  }
  throw new Error('The confirmed create transaction had no MarketCreated event.');
}

export class ArcMarketCreator implements MarketCreator {
  constructor(
    private readonly account: Account,
    private readonly publicClient: ArcPublicClient,
    private readonly writeClient: PredexWriteClient,
  ) {}

  async createMarket(
    input: MarketCreationInput,
  ): Promise<MarketCreationResult> {
    const params = (await this.publicClient.readContract({
      address: ADDRESSES.registry,
      abi: registryAbi,
      functionName: 'defaultParams',
    })) as unknown as DefaultMarketParams;

    if (
      input.seedAmountRaw < params.seedFloorRaw ||
      input.seedAmountRaw > params.seedCapRaw
    ) {
      throw new Error(
        `Seed ${input.seedAmountRaw} is outside the live range ` +
          `${params.seedFloorRaw}-${params.seedCapRaw}.`,
      );
    }
    if (
      input.tradingWindowSeconds <
        BigInt(params.minTradingWindowSeconds) ||
      input.tradingWindowSeconds > BigInt(params.maxTradingWindowSeconds)
    ) {
      throw new Error(
        `Trading window ${input.tradingWindowSeconds} is outside the live range ` +
          `${params.minTradingWindowSeconds}-${params.maxTradingWindowSeconds}.`,
      );
    }

    const requiredRaw = input.seedAmountRaw + params.openingFeeRaw;
    const [balance, allowance] = await Promise.all([
      this.publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: collateralErc20Abi,
        functionName: 'balanceOf',
        args: [this.account.address],
      }),
      this.publicClient.readContract({
        address: ADDRESSES.usdc,
        abi: collateralErc20Abi,
        functionName: 'allowance',
        args: [this.account.address, ADDRESSES.registry],
      }),
    ]);
    if (balance < requiredRaw) {
      throw new Error(
        `Insufficient Arc USDC: required ${requiredRaw} raw, wallet has ${balance} raw.`,
      );
    }

    if (allowance < requiredRaw) {
      const approvalHash = await this.writeClient.approveCollateral({
        spender: ADDRESSES.registry,
        amountRaw: requiredRaw,
      });
      const approvalReceipt =
        await this.publicClient.waitForTransactionReceipt({
          hash: approvalHash,
        });
      if (approvalReceipt.status !== 'success') {
        throw new Error(`Collateral approval ${approvalHash} reverted.`);
      }
    }

    const metadata = buildMarketMetadata(input.question);
    const txHash = await this.writeClient.createMarket({
      ...metadata,
      seedRaw: input.seedAmountRaw,
      openingFeeRaw: params.openingFeeRaw,
      tradingWindowSeconds: input.tradingWindowSeconds,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    if (receipt.status !== 'success') {
      throw new Error(`Market creation ${txHash} reverted.`);
    }
    return {
      marketId: marketIdFromReceipt(receipt),
      txHash,
    };
  }
}

export function createArcMarketCreator(account: Account): ArcMarketCreator {
  const publicClient = createPublicClient({
    chain: arcAgentChain,
    transport: http(ARC.rpcUrls[0]),
  });
  return new ArcMarketCreator(
    account,
    publicClient,
    createWriteClient({ account }),
  );
}
