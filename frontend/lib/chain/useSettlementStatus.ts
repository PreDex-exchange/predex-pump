'use client';

import type { ResolutionOutcome } from '@predex-pump/shared/domain';
import { useQuery } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';

import { ADDRESSES } from '@/lib/shared/addresses';

import {
  arcPublicClient,
  readSettlementEventState,
} from './client';
import {
  committeeOracleAbi,
  conditionalTokensAbi,
  incubatorLmsrAbi,
  incubatorRegistryAbi,
} from './contracts';

interface AmmState {
  protocolFeesAccruedRaw: bigint;
  resolved: boolean;
  closedOut: boolean;
}

type Lifecycle = readonly [
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

type Binding = readonly [
  Address,
  Address,
  Address,
  Hex,
  Hex,
  bigint,
  bigint,
];

type TerminalAccounting = readonly [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  number,
];

export interface SettlementStatus {
  creator: Address;
  lifecycleState: number;
  chainTimestamp: number;
  tradingEndsAt: number;
  resolutionEligible: boolean;
  questionId: Hex;
  conditionId: Hex;
  oracleResolved: boolean;
  questionThreshold: bigint;
  snapshotMember: boolean;
  payoutYes: bigint;
  payoutNo: bigint;
  payoutDenominator: bigint;
  outcome: ResolutionOutcome | null;
  lmsrResolved: boolean;
  lmsrClosedOut: boolean;
  yesBalanceRaw: bigint;
  noBalanceRaw: bigint;
  yesRedeemableRaw: bigint;
  noRedeemableRaw: bigint;
  fundingResidualRaw: bigint;
  fundingLossRaw: bigint;
  protocolPnlRaw: bigint;
  claimedResidualRaw: bigint;
  creatorFundingSharesRaw: bigint;
  totalFundingSharesRaw: bigint;
  creatorResidualClaimableRaw: bigint;
  protocolSweepAvailableRaw: bigint;
  protocolSweepCompleted: boolean;
  protocolSweptRaw: bigint;
  closedOutAt: number;
}

function payoutOutcome(
  payoutYes: bigint,
  payoutNo: bigint,
  denominator: bigint,
): ResolutionOutcome | null {
  if (denominator === 0n) return null;
  if (payoutYes === payoutNo) return 'INVALID';
  return payoutYes > payoutNo ? 'YES' : 'NO';
}

async function readSettlementStatus(
  marketId: bigint,
  account?: Address,
): Promise<SettlementStatus> {
  const [lifecycle, binding, tradingEndsAtRaw, block, ammState, terminal, events] =
    await Promise.all([
      arcPublicClient.readContract({
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'marketLifecycle',
        args: [marketId],
      }) as Promise<Lifecycle>,
      arcPublicClient.readContract({
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'tokenBinding',
        args: [marketId],
      }) as Promise<Binding>,
      arcPublicClient.readContract({
        address: ADDRESSES.registry,
        abi: incubatorRegistryAbi,
        functionName: 'marketTradingEndsAt',
        args: [marketId],
      }) as Promise<bigint>,
      arcPublicClient.getBlock(),
      arcPublicClient.readContract({
        address: ADDRESSES.lmsr,
        abi: incubatorLmsrAbi,
        functionName: 'ammState',
        args: [marketId],
      }) as Promise<AmmState>,
      arcPublicClient.readContract({
        address: ADDRESSES.lmsr,
        abi: incubatorLmsrAbi,
        functionName: 'terminalAccounting',
        args: [marketId],
      }) as Promise<TerminalAccounting>,
      readSettlementEventState(marketId),
    ]);

  const questionId = binding[3];
  const conditionId = binding[4];
  const [
    oracleResolved,
    questionThreshold,
    snapshotMember,
    payoutYes,
    payoutNo,
    payoutDenominator,
    yesBalanceRaw,
    noBalanceRaw,
    creatorFundingSharesRaw,
    totalFundingSharesRaw,
  ] = await Promise.all([
    arcPublicClient.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'isResolved',
      args: [questionId],
    }) as Promise<boolean>,
    arcPublicClient.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'questionThreshold',
      args: [questionId],
    }) as Promise<bigint>,
    account
      ? (arcPublicClient.readContract({
          address: ADDRESSES.oracle,
          abi: committeeOracleAbi,
          functionName: 'isSnapshotMember',
          args: [questionId, account],
        }) as Promise<boolean>)
      : Promise.resolve(false),
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'payoutNumerators',
      args: [conditionId, 0n],
    }) as Promise<bigint>,
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'payoutNumerators',
      args: [conditionId, 1n],
    }) as Promise<bigint>,
    arcPublicClient.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'payoutDenominator',
      args: [conditionId],
    }) as Promise<bigint>,
    account
      ? (arcPublicClient.readContract({
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'balanceOf',
          args: [account, binding[5]],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
    account
      ? (arcPublicClient.readContract({
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'balanceOf',
          args: [account, binding[6]],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
    account
      ? (arcPublicClient.readContract({
          address: ADDRESSES.lmsr,
          abi: incubatorLmsrAbi,
          functionName: 'fundingShares',
          args: [marketId, account],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
    arcPublicClient.readContract({
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'totalFundingShares',
      args: [marketId],
    }) as Promise<bigint>,
  ]);

  const fundingResidualRaw = terminal[0];
  const protocolPnlRaw = terminal[2];
  const protocolPnlSweptRaw = terminal[3];
  const creatorResidualClaimableRaw =
    creatorFundingSharesRaw > 0n && totalFundingSharesRaw > 0n
      ? (fundingResidualRaw * creatorFundingSharesRaw) /
        totalFundingSharesRaw
      : 0n;
  const protocolSweepAvailableRaw = events.protocolSweepCompleted
    ? 0n
    : ammState.protocolFeesAccruedRaw +
      (protocolPnlRaw - protocolPnlSweptRaw);
  const lifecycleState = Number(lifecycle[2]);
  const tradingEndsAt = Number(tradingEndsAtRaw);
  const chainTimestamp = Number(block.timestamp);

  return {
    creator: lifecycle[0],
    lifecycleState,
    chainTimestamp,
    tradingEndsAt,
    resolutionEligible:
      lifecycleState < 4 &&
      (lifecycleState === 3 || chainTimestamp >= tradingEndsAt),
    questionId,
    conditionId,
    oracleResolved,
    questionThreshold,
    snapshotMember,
    payoutYes,
    payoutNo,
    payoutDenominator,
    outcome: payoutOutcome(payoutYes, payoutNo, payoutDenominator),
    lmsrResolved: ammState.resolved,
    lmsrClosedOut: ammState.closedOut,
    yesBalanceRaw,
    noBalanceRaw,
    yesRedeemableRaw:
      payoutDenominator > 0n
        ? (yesBalanceRaw * payoutYes) / payoutDenominator
        : 0n,
    noRedeemableRaw:
      payoutDenominator > 0n
        ? (noBalanceRaw * payoutNo) / payoutDenominator
        : 0n,
    fundingResidualRaw,
    fundingLossRaw: terminal[1],
    protocolPnlRaw,
    claimedResidualRaw: terminal[7],
    creatorFundingSharesRaw,
    totalFundingSharesRaw,
    creatorResidualClaimableRaw,
    protocolSweepAvailableRaw,
    protocolSweepCompleted: events.protocolSweepCompleted,
    protocolSweptRaw: events.protocolSweptRaw,
    closedOutAt: Number(terminal[8]),
  };
}

export function useSettlementStatus(marketId: string, account?: Address) {
  return useQuery<SettlementStatus, Error>({
    queryKey: ['settlement', marketId, account],
    queryFn: () => readSettlementStatus(BigInt(marketId), account),
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}
