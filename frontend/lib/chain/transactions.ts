import {
  decodeEventLog,
  getAddress,
  keccak256,
  maxUint256,
  stringToHex,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import {
  getAccount,
  waitForTransactionReceipt,
  writeContract,
} from 'wagmi/actions';

import { ADDRESSES, ARC } from '@/lib/shared/addresses';

import { arcPublicClient } from './client';
import { wagmiConfig } from './config';
import {
  collateralErc20Abi,
  conditionalTokensAbi,
  incubatorLmsrAbi,
  incubatorRegistryAbi,
} from './contracts';

const DEADLINE_BUFFER_SECONDS = 20n * 60n;
const BPS_SCALE = 10_000n;

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
  report,
}: CreateMarketInput) {
  if (seedRaw <= 0n) throw new Error('The seed must be greater than zero.');
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
      args: [ancillaryData, seedRaw, params.openingFeeRaw, metadataHash],
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
  })) as readonly [Address, Address, Address, Hex, Hex, bigint, bigint];
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
