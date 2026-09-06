import {
  arcAgentChain,
  createWriteClient,
  type PredexWriteClient,
} from '@predex-pump/agent-sdk';
import {
  ADDRESSES,
  assertAllowedMinimumTickSizeRaw,
  isOrderSizeGranular,
  isPriceOnTick,
  leavesRepresentableRemainder,
} from '@predex-pump/shared';
import {
  collateralErc20Abi,
  miniClobFillPaymentRaw,
} from '@predex-pump/shared/tx';
import conditionalTokensAbiJson from '@predex-pump/shared/abis/ConditionalTokens.json' with {
  type: 'json',
};
import incubatorRegistryAbiJson from '@predex-pump/shared/abis/IncubatorRegistry.json' with {
  type: 'json',
};
import miniClobAbiJson from '@predex-pump/shared/abis/MiniCLOB.json' with {
  type: 'json',
};
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  type Abi,
  type Account,
  type Address,
  type Hash,
  type Hex,
} from 'viem';

import {
  BroadcastUncertainError,
  type CancelOrderAction,
  type FillOrderAction,
  type PlaceOrderAction,
  type TraderExecutor,
} from './agent.js';

const conditionalTokensAbi = conditionalTokensAbiJson as Abi;
const incubatorRegistryAbi = incubatorRegistryAbiJson as Abi;
const miniClobAbi = miniClobAbiJson as Abi;

interface MarketLifecycle {
  2: number;
  3: boolean;
}

type TokenBinding = readonly [
  Address,
  Address,
  Address,
  Hex,
  Hex,
  bigint,
  bigint,
];

interface MiniClobOrder {
  maker: Address;
  conditionId: Hex;
  tokenId: bigint;
  side: number;
  priceRawPerToken: bigint;
  sizeRaw: bigint;
  filledRaw: bigint;
  open: boolean;
}

interface ChainReceipt {
  status: 'success' | 'reverted';
  logs: readonly {
    address: Address;
    data: Hex;
    topics: readonly Hex[];
  }[];
}

export interface TraderChainClient {
  getBlock(parameters: { blockTag: 'latest' }): Promise<{
    number: bigint | null;
    timestamp: bigint;
  }>;
  readContract(parameters: {
    address: Address;
    abi: Abi | readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown>;
  waitForTransactionReceipt(parameters: { hash: Hash }): Promise<ChainReceipt>;
}

export type TraderWriteClient = Pick<
  PredexWriteClient,
  | 'approveCollateral'
  | 'approveCtfOperator'
  | 'placeOrder'
  | 'fillOrder'
  | 'cancelOrder'
>;

function sameAddress(left: Address, right: Address): boolean {
  return getAddress(left) === getAddress(right);
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireHex(value: string, label: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`${label} must be a 32-byte 0x-prefixed value.`);
  }
  return value as Hex;
}

function requireUnsigned(value: string, label: string): bigint {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${label} must be an unsigned decimal integer.`);
  }
  return BigInt(value);
}

export class ArcTraderExecutor implements TraderExecutor {
  constructor(
    private readonly account: Account,
    private readonly chainClient: TraderChainClient,
    private readonly writeClient: TraderWriteClient,
  ) {}

  private async waitForSuccess(
    hash: Hash,
    label: string,
    actionMayHaveCommitted = false,
  ): Promise<ChainReceipt> {
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
    return receipt;
  }

  private async readTradableBinding(
    marketId: bigint,
    expectedTradingEndsAt: number,
    expectedConditionId: Hex,
    expectedTokenId: bigint,
    outcome: 'YES' | 'NO',
  ): Promise<TokenBinding> {
    if (!Number.isSafeInteger(expectedTradingEndsAt) || expectedTradingEndsAt <= 0) {
      throw new Error('Indexed market trading deadline is invalid.');
    }
    const block = await this.chainClient.getBlock({ blockTag: 'latest' });
    if (block.number === null) {
      throw new Error('Latest Arc block omitted its number.');
    }
    const [lifecycleValue, bindingValue, tradingEndsAtValue] = await Promise.all([
      this.chainClient.readContract({
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'marketLifecycle',
        args: [marketId],
        blockNumber: block.number,
      }),
      this.chainClient.readContract({
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'tokenBinding',
        args: [marketId],
        blockNumber: block.number,
      }),
      this.chainClient.readContract({
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'marketTradingEndsAt',
        args: [marketId],
        blockNumber: block.number,
      }),
    ]);
    const lifecycle = lifecycleValue as MarketLifecycle;
    const binding = bindingValue as TokenBinding;
    if (Number(lifecycle[2]) !== 3 || lifecycle[3]) {
      throw new Error(
        'Fresh Arc state says the market is not an unpaused Graduated market.',
      );
    }
    if (
      !sameAddress(binding[0], ADDRESSES.usdc) ||
      !sameAddress(binding[1], ADDRESSES.ctf) ||
      !sameAddress(binding[2], ADDRESSES.oracle)
    ) {
      throw new Error(
        'Fresh Arc token binding does not match the configured deployment.',
      );
    }
    if (!sameHex(binding[4], expectedConditionId)) {
      throw new Error('Fresh Arc condition binding differs from the indexed market.');
    }
    const boundTokenId = outcome === 'YES' ? binding[5] : binding[6];
    if (boundTokenId !== expectedTokenId) {
      throw new Error('Fresh Arc token binding differs from the indexed market.');
    }
    if (
      typeof tradingEndsAtValue !== 'bigint' ||
      tradingEndsAtValue !== BigInt(expectedTradingEndsAt)
    ) {
      throw new Error('Fresh Registry trading deadline differs from the indexed market.');
    }
    const [prepared, payoutDenominator] = await Promise.all([
      this.chainClient.readContract({
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'isConditionPrepared',
        args: [binding[4]],
        blockNumber: block.number,
      }) as Promise<boolean>,
      this.chainClient.readContract({
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'payoutDenominator',
        args: [binding[4]],
        blockNumber: block.number,
      }) as Promise<bigint>,
    ]);
    if (!prepared) throw new Error('Fresh Arc condition is not prepared.');
    if (payoutDenominator !== 0n) {
      throw new Error('Fresh Arc condition is resolved; place/fill is forbidden.');
    }
    if (block.timestamp >= tradingEndsAtValue) {
      throw new Error('Fresh Arc state says the global trading deadline has ended.');
    }
    return binding;
  }

  private async readOrder(orderId: bigint): Promise<MiniClobOrder> {
    return (await this.chainClient.readContract({
      address: ADDRESSES.miniClob,
      abi: miniClobAbi,
      functionName: 'getOrder',
      args: [orderId],
    })) as MiniClobOrder;
  }

  private async approveCollateral(amountRaw: bigint): Promise<void> {
    const hash = await this.writeClient.approveCollateral({
      spender: ADDRESSES.miniClob,
      amountRaw,
    });
    await this.waitForSuccess(hash, 'USDC approval');
  }

  private async approveCtf(): Promise<void> {
    const hash = await this.writeClient.approveCtfOperator({
      operator: ADDRESSES.miniClob,
      approved: true,
    });
    await this.waitForSuccess(hash, 'CTF approval');
  }

  async placeOrder(
    action: PlaceOrderAction,
  ): Promise<{ txHash: `0x${string}`; orderId: string }> {
    if (action.priceRaw <= 0n || action.priceRaw > 1_000_000n) {
      throw new Error('Exact quote price is outside the MiniCLOB range.');
    }
    assertAllowedMinimumTickSizeRaw(action.minimumTickSizeRaw);
    if (!isPriceOnTick(action.priceRaw, action.minimumTickSizeRaw)) {
      throw new Error('Exact quote price is not aligned to the market tick.');
    }
    if (!isOrderSizeGranular(action.sizeRaw)) {
      throw new Error('Exact quote size is not aligned to the size quantum.');
    }
    const marketId = requireUnsigned(action.marketId, 'marketId');
    const conditionId = requireHex(action.conditionId, 'conditionId');
    const tokenId = requireUnsigned(action.tokenId, 'tokenId');
    const escrowRaw =
      action.side === 'BID'
        ? (action.priceRaw * action.sizeRaw + 999_999n) / 1_000_000n
        : action.sizeRaw;

    let binding: TokenBinding | null = null;
    for (let pass = 0; pass < 2; pass += 1) {
      binding = await this.readTradableBinding(
        marketId,
        action.tradingEndsAt,
        conditionId,
        tokenId,
        action.outcome,
      );
      if (action.side === 'BID') {
        const [balance, allowance] = await Promise.all([
          this.chainClient.readContract({
            address: ADDRESSES.usdc,
            abi: collateralErc20Abi,
            functionName: 'balanceOf',
            args: [this.account.address],
          }) as Promise<bigint>,
          this.chainClient.readContract({
            address: ADDRESSES.usdc,
            abi: collateralErc20Abi,
            functionName: 'allowance',
            args: [this.account.address, ADDRESSES.miniClob],
          }) as Promise<bigint>,
        ]);
        if (balance < escrowRaw) {
          throw new Error(
            `Fresh Arc USDC balance ${balance} is below exact BID escrow ${escrowRaw}.`,
          );
        }
        if (allowance >= escrowRaw) break;
        await this.approveCollateral(escrowRaw);
        binding = null;
        continue;
      }

      const [balance, approved] = await Promise.all([
        this.chainClient.readContract({
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'balanceOf',
          args: [this.account.address, tokenId],
        }) as Promise<bigint>,
        this.chainClient.readContract({
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'isApprovedForAll',
          args: [this.account.address, ADDRESSES.miniClob],
        }) as Promise<boolean>,
      ]);
      if (balance < action.sizeRaw) {
        throw new Error(
          `Fresh Arc CTF balance ${balance} is below exact ASK escrow ${action.sizeRaw}.`,
        );
      }
      if (approved) break;
      await this.approveCtf();
      binding = null;
    }
    if (binding === null) {
      throw new Error('Live approval remained insufficient after an exact approval.');
    }

    const txHash = await this.writeClient.placeOrder({
      conditionId: binding[4],
      tokenId,
      side: action.side,
      priceRaw: action.priceRaw,
      sizeRaw: action.sizeRaw,
    });
    const receipt = await this.waitForSuccess(txHash, 'place', true);
    let orderId: string | null = null;
    for (const log of receipt.logs) {
      if (!sameAddress(log.address, ADDRESSES.miniClob)) continue;
      try {
        const decoded = decodeEventLog({
          abi: miniClobAbi,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
          strict: false,
        });
        if (decoded.eventName !== 'OrderPlaced') continue;
        const args = decoded.args as unknown as Record<string, unknown>;
        if (typeof args.orderId === 'bigint') orderId = args.orderId.toString();
      } catch {
        // Ignore collateral/CTF logs in the receipt.
      }
    }
    return {
      txHash,
      // Keep an unknown confirmed order conservative in the in-flight set until
      // an operator restarts or the indexed event supplies its real id.
      orderId: orderId ?? `unindexed:${txHash}`,
    };
  }

  private async readFreshFill(
    action: FillOrderAction,
    orderId: bigint,
    marketId: bigint,
    conditionId: Hex,
    tokenId: bigint,
  ): Promise<{ order: MiniClobOrder; paymentRaw: bigint }> {
    await this.readTradableBinding(
      marketId,
      action.tradingEndsAt,
      conditionId,
      tokenId,
      action.outcome,
    );
    const [order, minimumFillRaw] = await Promise.all([
      this.readOrder(orderId),
      this.chainClient.readContract({
        address: ADDRESSES.miniClob,
        abi: miniClobAbi,
        functionName: 'minimumFillRaw',
        args: [orderId],
      }) as Promise<bigint>,
    ]);
    if (!order.open) throw new Error(`Fresh MiniCLOB order ${orderId} is closed.`);
    if (sameAddress(order.maker, this.account.address)) {
      throw new Error('Refusing to self-fill the signing account\'s order.');
    }
    if (
      !sameHex(order.conditionId, conditionId) ||
      order.tokenId !== tokenId
    ) {
      throw new Error('Fresh MiniCLOB order binding differs from the decision input.');
    }
    const expectedSide = action.restingSide === 'BID' ? 0 : 1;
    if (
      Number(order.side) !== expectedSide ||
      order.priceRawPerToken !== action.expectedPriceRaw
    ) {
      throw new Error('Fresh MiniCLOB side/price differs from the decision input.');
    }
    const remainingRaw = order.sizeRaw - order.filledRaw;
    if (action.fillSizeRaw > remainingRaw) {
      throw new Error(
        `Exact fill ${action.fillSizeRaw} exceeds fresh remaining ${remainingRaw}.`,
      );
    }
    if (!leavesRepresentableRemainder(remainingRaw, action.fillSizeRaw)) {
      throw new Error(
        'Exact fill would leave a remainder outside the exchange size quantum.',
      );
    }
    if (action.fillSizeRaw < minimumFillRaw) {
      throw new Error(
        `Exact fill ${action.fillSizeRaw} is below fresh minimum ${minimumFillRaw}.`,
      );
    }
    return {
      order,
      paymentRaw: miniClobFillPaymentRaw(
        order.priceRawPerToken,
        order.filledRaw,
        action.fillSizeRaw,
      ),
    };
  }

  async fillOrder(action: FillOrderAction): Promise<{ txHash: `0x${string}` }> {
    if (action.fillSizeRaw <= 0n) throw new Error('Exact fill size must be positive.');
    const orderId = requireUnsigned(action.orderId, 'orderId');
    const marketId = requireUnsigned(action.marketId, 'marketId');
    const conditionId = requireHex(action.conditionId, 'conditionId');
    const tokenId = requireUnsigned(action.tokenId, 'tokenId');

    let fresh: Awaited<ReturnType<ArcTraderExecutor['readFreshFill']>> | null =
      null;
    for (let pass = 0; pass < 2; pass += 1) {
      fresh = await this.readFreshFill(
        action,
        orderId,
        marketId,
        conditionId,
        tokenId,
      );
      if (action.restingSide === 'ASK') {
        const [balance, allowance] = await Promise.all([
          this.chainClient.readContract({
            address: ADDRESSES.usdc,
            abi: collateralErc20Abi,
            functionName: 'balanceOf',
            args: [this.account.address],
          }) as Promise<bigint>,
          this.chainClient.readContract({
            address: ADDRESSES.usdc,
            abi: collateralErc20Abi,
            functionName: 'allowance',
            args: [this.account.address, ADDRESSES.miniClob],
          }) as Promise<bigint>,
        ]);
        if (balance < fresh.paymentRaw) {
          throw new Error(
            `Fresh Arc USDC balance ${balance} is below exact fill payment ${fresh.paymentRaw}.`,
          );
        }
        if (allowance >= fresh.paymentRaw) break;
        await this.approveCollateral(fresh.paymentRaw);
        fresh = null;
        continue;
      }

      const [balance, approved] = await Promise.all([
        this.chainClient.readContract({
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'balanceOf',
          args: [this.account.address, tokenId],
        }) as Promise<bigint>,
        this.chainClient.readContract({
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'isApprovedForAll',
          args: [this.account.address, ADDRESSES.miniClob],
        }) as Promise<boolean>,
      ]);
      if (balance < action.fillSizeRaw) {
        throw new Error(
          `Fresh Arc CTF balance ${balance} is below exact fill ${action.fillSizeRaw}.`,
        );
      }
      if (approved) break;
      await this.approveCtf();
      fresh = null;
    }
    if (fresh === null) {
      throw new Error('Live counter-asset approval remained insufficient.');
    }
    const txHash = await this.writeClient.fillOrder({
      orderId,
      fillSizeRaw: action.fillSizeRaw,
    });
    await this.waitForSuccess(txHash, 'fill', true);
    return { txHash };
  }

  async cancelOrder(
    action: CancelOrderAction,
  ): Promise<{ txHash: `0x${string}` }> {
    const orderId = requireUnsigned(action.orderId, 'orderId');
    const order = await this.readOrder(orderId);
    if (!order.open) throw new Error(`Fresh MiniCLOB order ${orderId} is closed.`);
    if (!sameAddress(order.maker, this.account.address)) {
      throw new Error('Fresh MiniCLOB maker is not the signing account.');
    }
    const txHash = await this.writeClient.cancelOrder({ orderId });
    await this.waitForSuccess(txHash, 'cancel', true);
    return { txHash };
  }
}

export function createArcTraderExecutor(
  account: Account,
  rpcUrl: string,
): ArcTraderExecutor {
  const publicClient = createPublicClient({
    chain: arcAgentChain,
    transport: http(rpcUrl),
  });
  return new ArcTraderExecutor(
    account,
    publicClient as unknown as TraderChainClient,
    createWriteClient({ account, rpcUrl }),
  );
}
