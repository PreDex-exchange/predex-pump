import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  hashMessage,
  keccak256,
  maxUint256,
  recoverMessageAddress,
  stringToHex,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import {
  getAccount,
  signMessage,
  waitForTransactionReceipt,
  writeContract,
} from 'wagmi/actions';

import { ADDRESSES, ARC } from '@/lib/shared/addresses';

import { arcPublicClient, readSettlementEventState } from './client';
import { wagmiConfig } from './config';
import {
  committeeOracleAbi,
  collateralErc20Abi,
  conditionalTokensAbi,
  incubatorLmsrAbi,
  incubatorRegistryAbi,
  miniClobAbi,
} from './contracts';

const DEADLINE_BUFFER_SECONDS = 20n * 60n;
const BPS_SCALE = 10_000n;
const MINI_CLOB_PRICE_SCALE = 1_000_000n;
const ZERO_COLLECTION_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;
const COMMITTEE_DOMAIN_LABEL = 'PredexCommitteeOracleV2';

export type ResolutionChoice = 'YES' | 'NO' | 'INVALID';

const RESOLUTION_PAYOUTS: Record<
  ResolutionChoice,
  readonly [bigint, bigint]
> = {
  YES: [1n, 0n],
  NO: [0n, 1n],
  INVALID: [1n, 1n],
};

export type TxPhase =
  | 'idle'
  | 'checking'
  | 'awaiting-approval'
  | 'approval-pending'
  | 'awaiting-signature'
  | 'pending'
  | 'confirmed'
  | 'reverted';

export interface TxProgress {
  phase: TxPhase;
  message: string;
  hash?: Hash;
  error?: string;
}

export type TxReporter = (progress: TxProgress) => void;

interface MarketParamsStruct {
  openingFeeRaw: bigint;
  seedFloorRaw: bigint;
  seedCapRaw: bigint;
  graduationTollRaw: bigint;
  minTradingWindowSeconds: number;
  maxTradingWindowSeconds: number;
}

interface BuyQuote {
  baseCostRaw: bigint;
  protocolFeeRaw: bigint;
  depthContributionRaw: bigint;
  totalCostRaw: bigint;
}

interface SellQuote {
  grossBaseProceedsRaw: bigint;
  protocolFeeRaw: bigint;
  depthContributionRaw: bigint;
  netProceedsRaw: bigint;
}

interface CreateMarketInput {
  account: Address;
  ancillaryData: Hex;
  metadataHash: Hex;
  seedRaw: bigint;
  tradingWindowSeconds: bigint;
  report: TxReporter;
}

interface TradeInput {
  account: Address;
  marketId: bigint;
  outcome: 'YES' | 'NO';
  amountRaw: bigint;
  slippageBps?: number;
  report: TxReporter;
}

interface GraduateInput {
  account: Address;
  marketId: bigint;
  report: TxReporter;
}

interface ResolveInput extends GraduateInput {
  outcome: ResolutionChoice;
}

interface RedeemInput extends GraduateInput {
  outcome: 'YES' | 'NO';
}

interface PlaceOrderInput {
  account: Address;
  marketId: bigint;
  outcome: 'YES' | 'NO';
  side: 'BID' | 'ASK';
  priceRaw: bigint;
  sizeRaw: bigint;
  report: TxReporter;
}

interface FillOrderInput {
  account: Address;
  orderId: bigint;
  fillSizeRaw: bigint;
  report: TxReporter;
}

interface CancelOrderInput {
  account: Address;
  orderId: bigint;
  report: TxReporter;
}

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

interface ContractWrite {
  address: Address;
  abi: Abi | typeof collateralErc20Abi;
  functionName: string;
  args: readonly unknown[];
}

function assertConnectedAccount(expectedAccount: Address) {
  const account = getAccount(wagmiConfig);
  if (!account.isConnected || !account.address) {
    throw new Error('Connect an injected wallet before continuing.');
  }
  if (account.chainId !== ARC.chainId) {
    throw new Error(`Switch the wallet to ${ARC.name} (${ARC.chainId}) first.`);
  }
  if (getAddress(account.address) !== getAddress(expectedAccount)) {
    throw new Error('The connected wallet account changed. Review the action again.');
  }
}

async function sendAndConfirm(
  account: Address,
  write: ContractWrite,
  labels: {
    awaiting: string;
    pending: string;
    confirmed: string;
    approval?: boolean;
  },
  report: TxReporter,
) {
  assertConnectedAccount(account);
  report({
    phase: labels.approval ? 'awaiting-approval' : 'awaiting-signature',
    message: labels.awaiting,
  });

  const hash = await writeContract(
    wagmiConfig,
    {
      chainId: ARC.chainId,
      address: write.address,
      abi: write.abi,
      functionName: write.functionName,
      args: write.args,
    } as never,
  );
  report({
    phase: labels.approval ? 'approval-pending' : 'pending',
    message: labels.pending,
    hash,
  });
  const receipt = await waitForTransactionReceipt(wagmiConfig, {
    chainId: ARC.chainId,
    hash,
    confirmations: 1,
  });
  if (receipt.status !== 'success') {
    throw new Error(
      `${labels.pending} reverted on Arc. The RPC did not return a decoded contract reason (tx ${hash}).`,
    );
  }
  report({
    phase: labels.approval ? 'checking' : 'confirmed',
    message: labels.confirmed,
    hash,
  });
  return receipt;
}

async function readAllowance(account: Address, spender: Address) {
  return arcPublicClient.readContract({
    address: ADDRESSES.usdc,
    abi: collateralErc20Abi,
    functionName: 'allowance',
    args: [account, spender],
  });
}

async function readCollateralBalance(account: Address) {
  return arcPublicClient.readContract({
    address: ADDRESSES.usdc,
    abi: collateralErc20Abi,
    functionName: 'balanceOf',
    args: [account],
  });
}

type MarketLifecycle = readonly [
  Address,
  number,
  number,
  boolean,
  number,
  number,
  number,
  number,
  number,
];

type TokenBinding = readonly [
  Address,
  Address,
  Address,
  Hex,
  Hex,
  bigint,
  bigint,
];

async function readLifecycle(marketId: bigint) {
  return (await arcPublicClient.readContract({
    address: ADDRESSES.registry,
    abi: incubatorRegistryAbi,
    functionName: 'marketLifecycle',
    args: [marketId],
  })) as MarketLifecycle;
}

function sameAddress(left: Address, right: Address) {
  return getAddress(left) === getAddress(right);
}

function assertDeploymentBinding(binding: TokenBinding) {
  if (
    !sameAddress(binding[0], ADDRESSES.usdc) ||
    !sameAddress(binding[1], ADDRESSES.ctf) ||
    !sameAddress(binding[2], ADDRESSES.oracle)
  ) {
    throw new Error(
      'The live market token binding does not match the configured Arc deployment.',
    );
  }
}

async function approveCollateral(
  account: Address,
  spender: Address,
  amountRaw: bigint,
  label: string,
  report: TxReporter,
) {
  assertConnectedAccount(account);
  await sendAndConfirm(
    account,
    {
      address: ADDRESSES.usdc,
      abi: collateralErc20Abi,
      functionName: 'approve',
      args: [spender, amountRaw],
    },
    {
      awaiting: `Approve ${label} to spend the required six-decimal Arc USDC.`,
      pending: `${label} USDC approval is pending on Arc…`,
      confirmed: `${label} USDC approval confirmed. Refreshing transaction-critical state…`,
      approval: true,
    },
    report,
  );
}

async function approveCtfOperator(
  account: Address,
  operator: Address,
  label: string,
  report: TxReporter,
) {
  assertConnectedAccount(account);
  await sendAndConfirm(
    account,
    {
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'setApprovalForAll',
      args: [operator, true],
    },
    {
      awaiting: `Approve ${label} as a CTF ERC-1155 operator.`,
      pending: `${label} CTF operator approval is pending on Arc…`,
      confirmed: `${label} CTF operator approval confirmed. Refreshing transaction-critical state…`,
      approval: true,
    },
    report,
  );
}

async function assertTradable(marketId: bigint) {
  const lifecycle = (await arcPublicClient.readContract({
    address: ADDRESSES.registry,
    abi: incubatorRegistryAbi,
    functionName: 'marketLifecycle',
    args: [marketId],
  })) as readonly [Address, number, number, boolean, ...unknown[]];
  if (lifecycle[2] !== 1 || lifecycle[3]) {
    throw new Error(
      'This market is no longer in an unpaused bootstrap state. Refresh before trading.',
    );
  }
}

function addSlippage(raw: bigint, slippageBps: number) {
  const bps = BigInt(slippageBps);
  return (raw * (BPS_SCALE + bps) + BPS_SCALE - 1n) / BPS_SCALE;
}

function subtractSlippage(raw: bigint, slippageBps: number) {
  const bps = BigInt(slippageBps);
  return (raw * (BPS_SCALE - bps)) / BPS_SCALE;
}

async function freshDeadline() {
  const block = await arcPublicClient.getBlock();
  return block.timestamp + DEADLINE_BUFFER_SECONDS;
}

export function buildMarketMetadata(question: string) {
  // The proven Arc e2e uses a NUL-terminated ancillary byte string and hashes that
  // exact byte payload for metadataHash.
  const ancillaryData = stringToHex(`${question.trim()}\0`);
  return {
    ancillaryData,
    metadataHash: keccak256(ancillaryData),
  };
}

export async function createMarketOnArc({
  account,
  ancillaryData,
  metadataHash,
  seedRaw,
  tradingWindowSeconds,
  report,
}: CreateMarketInput) {
  if (seedRaw <= 0n) throw new Error('The seed must be greater than zero.');
  if (tradingWindowSeconds <= 0n) {
    throw new Error('The trading window must be greater than zero.');
  }
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message: 'Reading live registry parameters, balance, and allowance from Arc…',
  });

  let params: MarketParamsStruct | null = null;
  for (let approvalPass = 0; approvalPass < 3; approvalPass += 1) {
    assertConnectedAccount(account);
    params = (await arcPublicClient.readContract({
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'defaultParams',
    })) as MarketParamsStruct;
    if (seedRaw < params.seedFloorRaw || seedRaw > params.seedCapRaw) {
      throw new Error(
        `The live registry seed range changed. Required raw range: ${params.seedFloorRaw}–${params.seedCapRaw}.`,
      );
    }
    if (
      tradingWindowSeconds < BigInt(params.minTradingWindowSeconds) ||
      tradingWindowSeconds > BigInt(params.maxTradingWindowSeconds)
    ) {
      throw new Error(
        `The live registry trading-window range changed. Required seconds range: ${params.minTradingWindowSeconds}–${params.maxTradingWindowSeconds}.`,
      );
    }
    const requiredRaw = seedRaw + params.openingFeeRaw;
    const [balance, allowance] = await Promise.all([
      readCollateralBalance(account),
      readAllowance(account, ADDRESSES.registry),
    ]);
    if (balance < requiredRaw) {
      throw new Error(
        `Insufficient Arc USDC. Required ${requiredRaw} raw; wallet holds ${balance} raw.`,
      );
    }
    if (allowance >= requiredRaw) break;
    await approveCollateral(
      account,
      ADDRESSES.registry,
      requiredRaw,
      'Registry',
      report,
    );
    params = null;
  }
  if (!params) {
    throw new Error('The live registry allowance could not be made sufficient.');
  }

  assertConnectedAccount(account);
  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'createMarket',
      args: [
        ancillaryData,
        seedRaw,
        params.openingFeeRaw,
        tradingWindowSeconds,
        metadataHash,
      ],
    },
    {
      awaiting: 'Confirm createMarket in the injected wallet.',
      pending: 'Market creation is pending on Arc…',
      confirmed: 'Market creation confirmed on Arc.',
    },
    report,
  );

  return {
    receipt,
    marketId: marketIdFromReceipt(receipt),
  };
}

function marketIdFromReceipt(receipt: TransactionReceipt) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ADDRESSES.registry.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: incubatorRegistryAbi,
        data: log.data,
        topics: log.topics,
        strict: false,
      });
      if (decoded.eventName === 'MarketCreated') {
        const args = decoded.args as unknown as Record<string, unknown>;
        if (typeof args.marketId === 'bigint') return args.marketId.toString();
      }
    } catch {
      // Ignore unrelated registry logs from the same receipt.
    }
  }
  return null;
}

async function quoteBuyFresh(
  marketId: bigint,
  outcome: 'YES' | 'NO',
  amountRaw: bigint,
  slippageBps: number,
) {
  await assertTradable(marketId);
  const deadline = await freshDeadline();
  const quote = (await arcPublicClient.readContract({
    address: ADDRESSES.lmsr,
    abi: incubatorLmsrAbi,
    functionName: 'quoteBuy',
    args: [marketId, outcome === 'YES' ? 0 : 1, amountRaw, maxUint256, deadline],
  })) as BuyQuote;
  return {
    quote,
    deadline,
    maxCostRaw: addSlippage(quote.totalCostRaw, slippageBps),
  };
}

export async function buyOnArc({
  account,
  marketId,
  outcome,
  amountRaw,
  slippageBps = 50,
  report,
}: TradeInput) {
  if (amountRaw <= 0n) throw new Error('Enter a share amount greater than zero.');
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message: 'Refreshing the live LMSR quote, USDC balance, and allowance…',
  });

  let fresh:
    | Awaited<ReturnType<typeof quoteBuyFresh>>
    | null = null;
  for (let approvalPass = 0; approvalPass < 3; approvalPass += 1) {
    assertConnectedAccount(account);
    fresh = await quoteBuyFresh(
      marketId,
      outcome,
      amountRaw,
      slippageBps,
    );
    const [balance, allowance] = await Promise.all([
      readCollateralBalance(account),
      readAllowance(account, ADDRESSES.lmsr),
    ]);
    if (balance < fresh.maxCostRaw) {
      throw new Error(
        `Insufficient Arc USDC for the buffered cost. Required ${fresh.maxCostRaw} raw; wallet holds ${balance} raw.`,
      );
    }
    if (allowance >= fresh.maxCostRaw) break;
    await approveCollateral(
      account,
      ADDRESSES.lmsr,
      fresh.maxCostRaw,
      'LMSR',
      report,
    );
    fresh = null;
  }
  if (!fresh) throw new Error('The live LMSR allowance could not be made sufficient.');

  assertConnectedAccount(account);
  const functionName = outcome === 'YES' ? 'buyYes' : 'buyNo';
  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName,
      args: [marketId, amountRaw, fresh.maxCostRaw, fresh.deadline],
    },
    {
      awaiting: `Confirm ${functionName} in the injected wallet.`,
      pending: `${functionName} is pending on Arc…`,
      confirmed: `${functionName} confirmed on Arc.`,
    },
    report,
  );
  return {
    receipt,
    quote: fresh.quote,
    maxCostRaw: fresh.maxCostRaw,
    deadline: fresh.deadline,
  };
}

async function readTokenBinding(marketId: bigint) {
  return (await arcPublicClient.readContract({
    address: ADDRESSES.registry,
    abi: incubatorRegistryAbi,
    functionName: 'tokenBinding',
    args: [marketId],
  })) as TokenBinding;
}

export function cumulativeMiniClobPaymentRaw(
  priceRaw: bigint,
  sizeRaw: bigint,
) {
  if (priceRaw < 0n || sizeRaw < 0n) {
    throw new Error('MiniCLOB price and size cannot be negative.');
  }
  if (priceRaw === 0n || sizeRaw === 0n) return 0n;
  return (
    (priceRaw * sizeRaw + MINI_CLOB_PRICE_SCALE - 1n) /
    MINI_CLOB_PRICE_SCALE
  );
}

export function miniClobFillPaymentRaw(
  priceRaw: bigint,
  filledRaw: bigint,
  fillSizeRaw: bigint,
) {
  return (
    cumulativeMiniClobPaymentRaw(priceRaw, filledRaw + fillSizeRaw) -
    cumulativeMiniClobPaymentRaw(priceRaw, filledRaw)
  );
}

async function readMiniClobOrder(orderId: bigint) {
  return (await arcPublicClient.readContract({
    address: ADDRESSES.miniClob,
    abi: miniClobAbi,
    functionName: 'getOrder',
    args: [orderId],
  })) as unknown as MiniClobOrder;
}

async function readConditionState(conditionId: Hex) {
  const [prepared, payoutDenominator] = await Promise.all([
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'isConditionPrepared',
      args: [conditionId],
    }) as Promise<boolean>,
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'payoutDenominator',
      args: [conditionId],
    }) as Promise<bigint>,
  ]);
  if (!prepared) {
    throw new Error('The MiniCLOB condition is not prepared in Conditional Tokens.');
  }
  if (payoutDenominator !== 0n) {
    throw new Error(
      'This condition is resolved. New MiniCLOB orders and fills are disabled.',
    );
  }
}

function validateMiniClobOrderInput(priceRaw: bigint, sizeRaw: bigint) {
  if (priceRaw <= 0n || priceRaw > MINI_CLOB_PRICE_SCALE) {
    throw new Error(
      'Limit price must be greater than 0 and at most 1.000000 USDC per token.',
    );
  }
  if (sizeRaw <= 0n) throw new Error('Order size must be greater than zero.');
}

function miniClobEventArgs(
  receipt: TransactionReceipt,
  eventName: 'OrderPlaced' | 'OrderFilled' | 'OrderCancelled',
  orderId?: bigint,
) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ADDRESSES.miniClob.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: miniClobAbi,
        data: log.data,
        topics: log.topics,
        strict: false,
      });
      if (decoded.eventName !== eventName) continue;
      const args = decoded.args as unknown as Record<string, unknown>;
      if (
        orderId !== undefined &&
        typeof args.orderId === 'bigint' &&
        args.orderId !== orderId
      ) {
        continue;
      }
      return args;
    } catch {
      // Ignore ERC-20/ERC-1155 transfer logs in the MiniCLOB receipt.
    }
  }
  return null;
}

async function readGraduatedMarketBinding(marketId: bigint) {
  const [lifecycle, binding] = await Promise.all([
    readLifecycle(marketId),
    readTokenBinding(marketId),
  ]);
  assertDeploymentBinding(binding);
  if (Number(lifecycle[2]) !== 3) {
    throw new Error(
      'MiniCLOB orders can be placed only while the market is in the Graduated phase.',
    );
  }
  await readConditionState(binding[4]);
  return binding;
}

/**
 * Place an escrowed order directly on the deployed Arc MiniCLOB.
 * BID = 0 and ASK = 1, matching MiniCLOB.Side exactly.
 */
export async function placeOrderOnArc({
  account,
  marketId,
  outcome,
  side,
  priceRaw,
  sizeRaw,
  report,
}: PlaceOrderInput) {
  validateMiniClobOrderInput(priceRaw, sizeRaw);
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message:
      'Refreshing the graduated binding, condition, escrow balance, and MiniCLOB approval…',
  });

  const escrowRaw =
    side === 'BID'
      ? cumulativeMiniClobPaymentRaw(priceRaw, sizeRaw)
      : sizeRaw;
  let freshBinding: TokenBinding | null = null;
  let tokenId = 0n;

  for (let approvalPass = 0; approvalPass < 3; approvalPass += 1) {
    assertConnectedAccount(account);
    freshBinding = await readGraduatedMarketBinding(marketId);
    tokenId = outcome === 'YES' ? freshBinding[5] : freshBinding[6];

    if (side === 'BID') {
      const [balance, allowance] = await Promise.all([
        readCollateralBalance(account),
        readAllowance(account, ADDRESSES.miniClob),
      ]);
      if (balance < escrowRaw) {
        throw new Error(
          `Insufficient Arc USDC for BID escrow. Required ${escrowRaw} raw; wallet holds ${balance} raw.`,
        );
      }
      if (allowance >= escrowRaw) break;
      await approveCollateral(
        account,
        ADDRESSES.miniClob,
        escrowRaw,
        'MiniCLOB',
        report,
      );
      freshBinding = null;
      continue;
    }

    const [balance, approved] = await Promise.all([
      arcPublicClient.readContract({
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'balanceOf',
        args: [account, tokenId],
      }) as Promise<bigint>,
      arcPublicClient.readContract({
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'isApprovedForAll',
        args: [account, ADDRESSES.miniClob],
      }) as Promise<boolean>,
    ]);
    if (balance < sizeRaw) {
      throw new Error(
        `Insufficient ${outcome} tokens for ASK escrow. Required ${sizeRaw} raw; wallet holds ${balance} raw.`,
      );
    }
    if (approved) break;
    await approveCtfOperator(account, ADDRESSES.miniClob, 'MiniCLOB', report);
    freshBinding = null;
  }

  if (!freshBinding) {
    throw new Error('The live MiniCLOB approval could not be made sufficient.');
  }

  assertConnectedAccount(account);
  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.miniClob,
      abi: miniClobAbi,
      functionName: 'place',
      args: [
        freshBinding[4],
        tokenId,
        side === 'BID' ? 0 : 1,
        priceRaw,
        sizeRaw,
      ],
    },
    {
      awaiting: `Confirm MiniCLOB.place for the ${outcome} ${side}.`,
      pending: 'Order placement is pending on Arc…',
      confirmed: 'Order placed and escrowed on the Arc MiniCLOB.',
    },
    report,
  );
  const event = miniClobEventArgs(receipt, 'OrderPlaced');
  return {
    receipt,
    orderId: typeof event?.orderId === 'bigint' ? event.orderId : null,
    conditionId: freshBinding[4],
    tokenId,
    side,
    priceRaw,
    sizeRaw,
    escrowRaw,
  };
}

async function readFreshFillState(orderId: bigint, fillSizeRaw: bigint) {
  const [order, minimumFillRaw] = await Promise.all([
    readMiniClobOrder(orderId),
    arcPublicClient.readContract({
      address: ADDRESSES.miniClob,
      abi: miniClobAbi,
      functionName: 'minimumFillRaw',
      args: [orderId],
    }) as Promise<bigint>,
  ]);
  if (!order.open) throw new Error(`MiniCLOB order ${orderId} is no longer open.`);
  const remainingRaw = order.sizeRaw - order.filledRaw;
  if (fillSizeRaw > remainingRaw) {
    throw new Error(
      `Fill exceeds the live remaining size (${remainingRaw} raw).`,
    );
  }
  if (fillSizeRaw < minimumFillRaw) {
    throw new Error(
      `Fill is below the live MiniCLOB minimum (${minimumFillRaw} raw).`,
    );
  }
  await readConditionState(order.conditionId);
  return {
    order,
    minimumFillRaw,
    remainingRaw,
    paymentRaw: miniClobFillPaymentRaw(
      order.priceRawPerToken,
      order.filledRaw,
      fillSizeRaw,
    ),
  };
}

/**
 * Fill a resting order directly on MiniCLOB after re-reading the order and its
 * dynamic minimum. ASK makers receive taker USDC; BID makers receive taker CTF.
 */
export async function fillOrderOnArc({
  account,
  orderId,
  fillSizeRaw,
  report,
}: FillOrderInput) {
  if (fillSizeRaw <= 0n) throw new Error('Fill size must be greater than zero.');
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message:
      'Refreshing the MiniCLOB order, minimum fill, condition, balance, and counter-asset approval…',
  });

  let fresh: Awaited<ReturnType<typeof readFreshFillState>> | null = null;
  for (let approvalPass = 0; approvalPass < 3; approvalPass += 1) {
    assertConnectedAccount(account);
    fresh = await readFreshFillState(orderId, fillSizeRaw);

    if (Number(fresh.order.side) === 1) {
      const [balance, allowance] = await Promise.all([
        readCollateralBalance(account),
        readAllowance(account, ADDRESSES.miniClob),
      ]);
      if (balance < fresh.paymentRaw) {
        throw new Error(
          `Insufficient Arc USDC to fill this ASK. Required ${fresh.paymentRaw} raw; wallet holds ${balance} raw.`,
        );
      }
      if (allowance >= fresh.paymentRaw) break;
      await approveCollateral(
        account,
        ADDRESSES.miniClob,
        fresh.paymentRaw,
        'MiniCLOB',
        report,
      );
      fresh = null;
      continue;
    }

    const [balance, approved] = await Promise.all([
      arcPublicClient.readContract({
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'balanceOf',
        args: [account, fresh.order.tokenId],
      }) as Promise<bigint>,
      arcPublicClient.readContract({
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'isApprovedForAll',
        args: [account, ADDRESSES.miniClob],
      }) as Promise<boolean>,
    ]);
    if (balance < fillSizeRaw) {
      throw new Error(
        `Insufficient CTF tokens to fill this BID. Required ${fillSizeRaw} raw; wallet holds ${balance} raw.`,
      );
    }
    if (approved) break;
    await approveCtfOperator(account, ADDRESSES.miniClob, 'MiniCLOB', report);
    fresh = null;
  }

  if (!fresh) {
    throw new Error(
      'The live MiniCLOB counter-asset approval could not be made sufficient.',
    );
  }

  assertConnectedAccount(account);
  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.miniClob,
      abi: miniClobAbi,
      functionName: 'fill',
      args: [orderId, fillSizeRaw],
    },
    {
      awaiting: `Confirm MiniCLOB.fill for order ${orderId}.`,
      pending: `Order ${orderId} fill is pending on Arc…`,
      confirmed: `Order ${orderId} fill confirmed on Arc.`,
    },
    report,
  );
  const event = miniClobEventArgs(receipt, 'OrderFilled', orderId);
  return {
    receipt,
    orderId,
    order: fresh.order,
    fillSizeRaw,
    minimumFillRaw: fresh.minimumFillRaw,
    paymentRaw:
      typeof event?.paymentRaw === 'bigint'
        ? event.paymentRaw
        : fresh.paymentRaw,
  };
}

/**
 * Cancel the connected maker's own resting order. MiniCLOB deliberately permits
 * this after resolution so remaining escrow can still be returned.
 */
export async function cancelOrderOnArc({
  account,
  orderId,
  report,
}: CancelOrderInput) {
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message: 'Refreshing the MiniCLOB order, maker, and remaining escrow…',
  });
  const order = await readMiniClobOrder(orderId);
  if (!order.open) throw new Error(`MiniCLOB order ${orderId} is no longer open.`);
  if (!sameAddress(order.maker, account)) {
    throw new Error('Only the on-chain maker can cancel this MiniCLOB order.');
  }
  const remainingSizeRaw = order.sizeRaw - order.filledRaw;
  const expectedRefundRaw =
    Number(order.side) === 0
      ? cumulativeMiniClobPaymentRaw(
          order.priceRawPerToken,
          order.sizeRaw,
        ) -
        cumulativeMiniClobPaymentRaw(
          order.priceRawPerToken,
          order.filledRaw,
        )
      : remainingSizeRaw;

  assertConnectedAccount(account);
  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.miniClob,
      abi: miniClobAbi,
      functionName: 'cancel',
      args: [orderId],
    },
    {
      awaiting: `Confirm MiniCLOB.cancel for order ${orderId}.`,
      pending: `Order ${orderId} cancellation is pending on Arc…`,
      confirmed: `Order ${orderId} cancelled; remaining escrow returned.`,
    },
    report,
  );
  const event = miniClobEventArgs(receipt, 'OrderCancelled', orderId);
  return {
    receipt,
    orderId,
    order,
    remainingSizeRaw,
    refundRaw:
      typeof event?.refundRaw === 'bigint'
        ? event.refundRaw
        : expectedRefundRaw,
  };
}

export async function sellOnArc({
  account,
  marketId,
  outcome,
  amountRaw,
  slippageBps = 50,
  report,
}: TradeInput) {
  if (amountRaw <= 0n) throw new Error('Enter a share amount greater than zero.');
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message: 'Checking the live CTF balance and LMSR operator approval…',
  });

  let binding = await readTokenBinding(marketId);
  let tokenId = outcome === 'YES' ? binding[5] : binding[6];
  let [balance, approved] = await Promise.all([
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'balanceOf',
      args: [account, tokenId],
    }) as Promise<bigint>,
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'isApprovedForAll',
      args: [account, ADDRESSES.lmsr],
    }) as Promise<boolean>,
  ]);
  if (balance < amountRaw) {
    throw new Error(
      `Insufficient ${outcome} tokens. Required ${amountRaw} raw; wallet holds ${balance} raw.`,
    );
  }
  if (!approved) {
    await sendAndConfirm(
      account,
      {
        address: ADDRESSES.ctf,
        abi: conditionalTokensAbi,
        functionName: 'setApprovalForAll',
        args: [ADDRESSES.lmsr, true],
      },
      {
        awaiting: 'Approve the LMSR as a CTF ERC-1155 operator.',
        pending: 'CTF operator approval is pending on Arc…',
        confirmed: 'CTF operator approval confirmed. Refreshing the sell quote…',
        approval: true,
      },
      report,
    );
  }

  // Approval can take a block, so all transaction-critical state is re-read after it.
  assertConnectedAccount(account);
  await assertTradable(marketId);
  binding = await readTokenBinding(marketId);
  tokenId = outcome === 'YES' ? binding[5] : binding[6];
  const deadline = await freshDeadline();
  const [freshBalance, freshApproved, quote] = await Promise.all([
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'balanceOf',
      args: [account, tokenId],
    }) as Promise<bigint>,
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'isApprovedForAll',
      args: [account, ADDRESSES.lmsr],
    }) as Promise<boolean>,
    arcPublicClient.readContract({
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'quoteSell',
      args: [marketId, outcome === 'YES' ? 0 : 1, amountRaw, 0n, deadline],
    }) as Promise<SellQuote>,
  ]);
  balance = freshBalance;
  approved = freshApproved;
  if (balance < amountRaw) {
    throw new Error(`The ${outcome} token balance changed before signing. Refresh and retry.`);
  }
  if (!approved) {
    throw new Error('The LMSR CTF operator approval is no longer active.');
  }
  const minProceedsRaw = subtractSlippage(quote.netProceedsRaw, slippageBps);
  const functionName = outcome === 'YES' ? 'sellYes' : 'sellNo';
  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName,
      args: [marketId, amountRaw, minProceedsRaw, deadline],
    },
    {
      awaiting: `Confirm ${functionName} in the injected wallet.`,
      pending: `${functionName} is pending on Arc…`,
      confirmed: `${functionName} confirmed on Arc.`,
    },
    report,
  );
  return { receipt, quote, minProceedsRaw, deadline };
}

export async function graduateOnArc({
  account,
  marketId,
  report,
}: GraduateInput) {
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message: 'Refreshing graduation eligibility, toll, balance, and allowance…',
  });

  let tollRaw: bigint | null = null;
  for (let approvalPass = 0; approvalPass < 3; approvalPass += 1) {
    assertConnectedAccount(account);
    const [lifecycle, status, params] = await Promise.all([
      arcPublicClient.readContract({
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'marketLifecycle',
        args: [marketId],
      }) as Promise<readonly [Address, number, number, boolean, ...unknown[]]>,
      arcPublicClient.readContract({
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'graduationStatus',
        args: [marketId],
      }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint, bigint]>,
      arcPublicClient.readContract({
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'marketParams',
        args: [marketId],
      }) as Promise<MarketParamsStruct>,
    ]);
    if (lifecycle[2] !== 1 && lifecycle[2] !== 2) {
      throw new Error('This market is no longer in a bootstrap lifecycle state.');
    }
    if (!status[0]) {
      throw new Error(
        `The market is not currently graduation-qualified (activity ${status[1]} / ${status[2]} raw; earliest ${status[5]}).`,
      );
    }
    tollRaw = params.graduationTollRaw;
    const [balance, allowance] = await Promise.all([
      readCollateralBalance(account),
      readAllowance(account, ADDRESSES.registry),
    ]);
    if (balance < tollRaw) {
      throw new Error(
        `Insufficient Arc USDC for the graduation toll. Required ${tollRaw} raw; wallet holds ${balance} raw.`,
      );
    }
    if (allowance >= tollRaw) break;
    await approveCollateral(
      account,
      ADDRESSES.registry,
      tollRaw,
      'Registry graduation',
      report,
    );
    tollRaw = null;
  }
  if (tollRaw === null) {
    throw new Error('The graduation-toll allowance could not be made sufficient.');
  }

  assertConnectedAccount(account);
  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'graduateIfQualified',
      args: [marketId],
    },
    {
      awaiting: 'Confirm graduateIfQualified in the injected wallet.',
      pending: 'Graduation is pending on Arc…',
      confirmed: 'Graduation confirmed on Arc. The order book handoff is live.',
    },
    report,
  );
  return { receipt, tollRaw };
}

/**
 * CommitteeOracleAdapterV2 does not use EIP-712. Its source-of-truth digest is:
 *
 *   personal_sign(
 *     keccak256(abi.encode(
 *       keccak256(abi.encode("PredexCommitteeOracleV2", chainId, oracle)),
 *       questionId,
 *       payouts,
 *       nonce
 *     ))
 *   )
 *
 * Keep this helper exported so the live read-smoke and the wallet path share the
 * exact same encoding.
 */
export function buildCommitteeResolutionDigest({
  chainId,
  oracle,
  questionId,
  payouts,
  nonce,
}: {
  chainId: number;
  oracle: Address;
  questionId: Hex;
  payouts: readonly [bigint, bigint];
  nonce: bigint;
}) {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [COMMITTEE_DOMAIN_LABEL, BigInt(chainId), oracle],
    ),
  );
  const payloadDigest = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256[]' },
        { type: 'uint256' },
      ],
      [domainSeparator, questionId, [...payouts], nonce],
    ),
  );
  return {
    domainSeparator,
    payloadDigest,
    resolutionDigest: hashMessage({ raw: payloadDigest }),
  };
}

async function readResolutionEligibility(
  account: Address,
  marketId: bigint,
  payouts: readonly [bigint, bigint],
) {
  const [lifecycle, binding, tradingEndsAt, block] = await Promise.all([
    readLifecycle(marketId),
    readTokenBinding(marketId),
    arcPublicClient.readContract({
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'marketTradingEndsAt',
      args: [marketId],
    }) as Promise<bigint>,
    arcPublicClient.getBlock(),
  ]);
  assertDeploymentBinding(binding);

  const lifecycleState = Number(lifecycle[2]);
  if (
    lifecycleState === 4 ||
    lifecycleState === 5 ||
    (lifecycleState !== 3 && block.timestamp < tradingEndsAt)
  ) {
    throw new Error(
      'Resolution is available only after graduation or the live trading deadline.',
    );
  }

  const questionId = binding[3];
  const [
    initialized,
    resolved,
    currentMember,
    snapshotMember,
    threshold,
    nonce,
    onchainDomainSeparator,
    onchainResolutionDigest,
  ] = await Promise.all([
    arcPublicClient.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'isInitialized',
      args: [questionId],
    }) as Promise<boolean>,
    arcPublicClient.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'isResolved',
      args: [questionId],
    }) as Promise<boolean>,
    arcPublicClient.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'isCurrentMember',
      args: [account],
    }) as Promise<boolean>,
    arcPublicClient.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'isSnapshotMember',
      args: [questionId, account],
    }) as Promise<boolean>,
    arcPublicClient.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'questionThreshold',
      args: [questionId],
    }) as Promise<bigint>,
    arcPublicClient.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'questionNonce',
      args: [questionId],
    }) as Promise<bigint>,
    arcPublicClient.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'domainSeparator',
    }) as Promise<Hex>,
    arcPublicClient.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'resolutionDigest',
      args: [questionId, [...payouts]],
    }) as Promise<Hex>,
  ]);

  if (!initialized) throw new Error('The oracle question is not initialized.');
  if (resolved) throw new Error('The oracle question has already been resolved.');
  if (!currentMember || !snapshotMember) {
    throw new Error(
      'The connected wallet is not both a current and snapshotted committee signer.',
    );
  }
  if (threshold !== 1n) {
    throw new Error(
      `This UI can submit the demo threshold-1 flow only; the question threshold is ${threshold}.`,
    );
  }

  const digest = buildCommitteeResolutionDigest({
    chainId: ARC.chainId,
    oracle: ADDRESSES.oracle,
    questionId,
    payouts,
    nonce,
  });
  if (digest.domainSeparator !== onchainDomainSeparator) {
    throw new Error(
      'The client committee domain separator does not match the live oracle.',
    );
  }
  if (digest.resolutionDigest !== onchainResolutionDigest) {
    throw new Error(
      'The client committee resolution digest does not match the live oracle.',
    );
  }

  return {
    questionId,
    nonce,
    digest,
    onchainResolutionDigest,
  };
}

export async function resolveOnArc({
  account,
  marketId,
  outcome,
  report,
}: ResolveInput) {
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message:
      'Refreshing the lifecycle, deadline, oracle membership, nonce, and resolution digest…',
  });
  const payouts = RESOLUTION_PAYOUTS[outcome];
  const fresh = await readResolutionEligibility(
    account,
    marketId,
    payouts,
  );

  assertConnectedAccount(account);
  report({
    phase: 'awaiting-signature',
    message: `Sign the nonce-bound ${outcome} committee resolution message.`,
  });
  const signature = await signMessage(wagmiConfig, {
    account,
    message: { raw: fresh.digest.payloadDigest },
  });
  const recovered = await recoverMessageAddress({
    message: { raw: fresh.digest.payloadDigest },
    signature,
  });
  if (!sameAddress(recovered, account)) {
    throw new Error('The committee signature did not recover to the connected wallet.');
  }

  // A signature is useful only for one question nonce. Re-read all mutable
  // authorization state after the wallet returns and before requesting the tx.
  report({
    phase: 'checking',
    message: 'Signature captured. Re-checking the live committee nonce and membership…',
  });
  const rechecked = await readResolutionEligibility(
    account,
    marketId,
    payouts,
  );
  if (
    rechecked.nonce !== fresh.nonce ||
    rechecked.onchainResolutionDigest !== fresh.onchainResolutionDigest
  ) {
    throw new Error(
      'The committee question changed while the signature was open. Review and sign again.',
    );
  }

  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'resolve',
      args: [fresh.questionId, [...payouts], [signature]],
    },
    {
      awaiting: 'Confirm CommitteeOracleAdapterV2.resolve in the injected wallet.',
      pending: 'Committee resolution is pending on Arc…',
      confirmed: `${outcome} resolution confirmed on Arc. It can now be observed by the LMSR.`,
    },
    report,
  );
  return {
    receipt,
    questionId: fresh.questionId,
    payouts,
    digest: fresh.onchainResolutionDigest,
  };
}

export async function observeResolutionOnArc({
  account,
  marketId,
  report,
}: GraduateInput) {
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message: 'Refreshing the registry lifecycle and Conditional Tokens payouts…',
  });
  const [lifecycle, binding] = await Promise.all([
    readLifecycle(marketId),
    readTokenBinding(marketId),
  ]);
  assertDeploymentBinding(binding);
  if (Number(lifecycle[2]) === 4 || Number(lifecycle[2]) === 5) {
    throw new Error('This market resolution has already been observed.');
  }
  const [oracleResolved, denominator] = await Promise.all([
    arcPublicClient.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'isResolved',
      args: [binding[3]],
    }) as Promise<boolean>,
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'payoutDenominator',
      args: [binding[4]],
    }) as Promise<bigint>,
  ]);
  if (!oracleResolved || denominator === 0n) {
    throw new Error('The oracle resolution is not yet available to observe.');
  }

  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'observeResolution',
      args: [marketId],
    },
    {
      awaiting: 'Confirm IncubatorLMSR.observeResolution in the injected wallet.',
      pending: 'Resolution observation is pending on Arc…',
      confirmed: 'Resolution observed. Eligible CTF positions can now be redeemed.',
    },
    report,
  );
  return { receipt };
}

export async function redeemOnArc({
  account,
  marketId,
  outcome,
  report,
}: RedeemInput) {
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message: `Refreshing the ${outcome} CTF balance and payout vector…`,
  });
  const [lifecycle, binding] = await Promise.all([
    readLifecycle(marketId),
    readTokenBinding(marketId),
  ]);
  assertDeploymentBinding(binding);
  if (Number(lifecycle[2]) !== 4) {
    throw new Error(
      'Redemption is available in the ResolvedObserved phase before closeout.',
    );
  }

  const outcomeIndex = outcome === 'YES' ? 0n : 1n;
  const tokenId = outcome === 'YES' ? binding[5] : binding[6];
  const indexSet = outcome === 'YES' ? 1n : 2n;
  const [balance, numerator, denominator] = await Promise.all([
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'balanceOf',
      args: [account, tokenId],
    }) as Promise<bigint>,
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'payoutNumerators',
      args: [binding[4], outcomeIndex],
    }) as Promise<bigint>,
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'payoutDenominator',
      args: [binding[4]],
    }) as Promise<bigint>,
  ]);
  if (denominator === 0n) throw new Error('The CTF payout is not available.');
  if (balance === 0n || numerator === 0n) {
    throw new Error(`The connected wallet has no redeemable ${outcome} position.`);
  }
  const redeemableRaw = (balance * numerator) / denominator;

  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'redeemPositions',
      args: [ADDRESSES.usdc, ZERO_COLLECTION_ID, binding[4], [indexSet]],
    },
    {
      awaiting: `Confirm ConditionalTokens.redeemPositions for ${outcome}.`,
      pending: `${outcome} redemption is pending on Arc…`,
      confirmed: `${outcome} redemption confirmed on Arc.`,
    },
    report,
  );
  return { receipt, redeemableRaw, indexSet };
}

export async function closeoutOnArc({
  account,
  marketId,
  report,
}: GraduateInput) {
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message: 'Refreshing the registry and LMSR resolution state before closeout…',
  });
  const [lifecycle, ammState] = await Promise.all([
    readLifecycle(marketId),
    arcPublicClient.readContract({
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'ammState',
      args: [marketId],
    }) as Promise<{ resolved: boolean; closedOut: boolean }>,
  ]);
  if (
    Number(lifecycle[2]) !== 4 ||
    !ammState.resolved ||
    ammState.closedOut
  ) {
    throw new Error('The market is not in a fresh ResolvedObserved state.');
  }

  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'closeout',
      args: [marketId],
    },
    {
      awaiting: 'Confirm IncubatorLMSR.closeout in the injected wallet.',
      pending: 'Market closeout is pending on Arc…',
      confirmed: 'Market closeout confirmed on Arc.',
    },
    report,
  );
  return { receipt };
}

async function assertCreatorAtCloseout(account: Address, marketId: bigint) {
  const lifecycle = await readLifecycle(marketId);
  if (Number(lifecycle[2]) !== 5) {
    throw new Error('The market must be ClosedOut first.');
  }
  if (!sameAddress(lifecycle[0], account)) {
    throw new Error('Only the market creator can use this closeout control.');
  }
  return lifecycle;
}

export async function claimFundingResidualOnArc({
  account,
  marketId,
  report,
}: GraduateInput) {
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message: 'Refreshing creator funding shares and terminal accounting…',
  });
  await assertCreatorAtCloseout(account, marketId);
  const [shares, totalShares, terminal] = await Promise.all([
    arcPublicClient.readContract({
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'fundingShares',
      args: [marketId, account],
    }) as Promise<bigint>,
    arcPublicClient.readContract({
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'totalFundingShares',
      args: [marketId],
    }) as Promise<bigint>,
    arcPublicClient.readContract({
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'terminalAccounting',
      args: [marketId],
    }) as Promise<readonly [bigint, ...unknown[]]>,
  ]);
  const fundingResidualRaw = terminal[0];
  if (shares === 0n || totalShares === 0n || fundingResidualRaw === 0n) {
    throw new Error('The creator has no funding residual available to claim.');
  }
  const claimableRaw = (fundingResidualRaw * shares) / totalShares;
  if (claimableRaw === 0n) {
    throw new Error('The creator funding residual rounds to zero.');
  }

  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'claimFundingResidual',
      args: [marketId],
    },
    {
      awaiting: 'Confirm IncubatorLMSR.claimFundingResidual in the injected wallet.',
      pending: 'Funding residual claim is pending on Arc…',
      confirmed: 'Funding residual claimed on Arc.',
    },
    report,
  );
  return { receipt, claimableRaw };
}

export async function sweepProtocolAfterCloseoutOnArc({
  account,
  marketId,
  report,
}: GraduateInput) {
  assertConnectedAccount(account);
  report({
    phase: 'checking',
    message: 'Refreshing closeout protocol fees and PnL before the sweep…',
  });
  await assertCreatorAtCloseout(account, marketId);
  const [ammState, terminal, events] = await Promise.all([
    arcPublicClient.readContract({
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'ammState',
      args: [marketId],
    }) as Promise<{ protocolFeesAccruedRaw: bigint; closedOut: boolean }>,
    arcPublicClient.readContract({
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'terminalAccounting',
      args: [marketId],
    }) as Promise<
      readonly [bigint, bigint, bigint, bigint, ...unknown[]]
    >,
    readSettlementEventState(marketId, { fresh: true }),
  ]);
  if (!ammState.closedOut) throw new Error('The LMSR is not closed out.');
  if (events.protocolSweepCompleted) {
    throw new Error('The closeout protocol sweep has already completed.');
  }
  const protocolPnlAvailableRaw = terminal[2] - terminal[3];
  if (
    ammState.protocolFeesAccruedRaw === 0n &&
    protocolPnlAvailableRaw === 0n
  ) {
    throw new Error('There are no protocol fees or PnL available to sweep.');
  }

  const receipt = await sendAndConfirm(
    account,
    {
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'sweepProtocolAfterCloseout',
      args: [marketId],
    },
    {
      awaiting:
        'Confirm IncubatorLMSR.sweepProtocolAfterCloseout in the injected wallet.',
      pending: 'Protocol closeout sweep is pending on Arc…',
      confirmed: 'Protocol fees and PnL swept to the protocol depth account.',
    },
    report,
  );
  return { receipt };
}

export function chainErrorMessage(error: unknown) {
  const messages: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current === 'object') {
      const value = current as {
        name?: unknown;
        shortMessage?: unknown;
        details?: unknown;
        message?: unknown;
        errorName?: unknown;
        cause?: unknown;
        code?: unknown;
      };
      if (value.code === 4001) return 'The wallet signature request was rejected.';
      for (const candidate of [
        value.errorName,
        value.shortMessage,
        value.details,
        value.message,
      ]) {
        if (
          typeof candidate === 'string' &&
          candidate.trim() &&
          !messages.includes(candidate.trim())
        ) {
          messages.push(candidate.trim());
        }
      }
      current = value.cause;
    } else {
      messages.push(String(current));
      break;
    }
  }

  const preferred = messages.find(
    (message) =>
      !message.startsWith('Contract Call:') &&
      !message.startsWith('Request Arguments:') &&
      message.length < 500,
  );
  return preferred ?? messages[0] ?? 'The Arc transaction could not be completed.';
}
