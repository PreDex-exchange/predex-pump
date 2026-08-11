'use client';

import type {
  Market,
  ResolutionOutcome,
} from '@predex-pump/shared/domain';
import { useQuery } from '@tanstack/react-query';
import type { Address, Hex } from 'viem';

import { ADDRESSES } from '@/lib/shared/addresses';

import { ARC_READ_CACHE_MS, arcPublicClient } from './client';
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

export interface IndexedSettlementEvents {
  protocolSweepCompleted: boolean;
  protocolSweptRaw: string;
}

const EMPTY_SETTLEMENT_EVENTS: IndexedSettlementEvents = {
  protocolSweepCompleted: false,
  protocolSweptRaw: '0',
};

function payoutOutcome(
  payoutYes: bigint,
  payoutNo: bigint,
  denominator: bigint,
): ResolutionOutcome | null {
  if (denominator === 0n) return null;
  if (payoutYes === payoutNo) return 'INVALID';
  return payoutYes > payoutNo ? 'YES' : 'NO';
}

export async function readSettlementStatus(
  market: Market,
  account?: Address,
  settlementEvents: IndexedSettlementEvents = EMPTY_SETTLEMENT_EVENTS,
  client: Pick<typeof arcPublicClient, 'getBlock' | 'readContract'> =
    arcPublicClient,
): Promise<SettlementStatus> {
  const marketId = BigInt(market.id);
  const questionId = market.questionId as Hex;
  const conditionId = market.conditionId as Hex;
  const yesTokenId = BigInt(market.yesTokenId);
  const noTokenId = BigInt(market.noTokenId);
  const [
    lifecycle,
    block,
    ammState,
    terminal,
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
    client.readContract({
      address: ADDRESSES.registry,
      abi: incubatorRegistryAbi,
      functionName: 'marketLifecycle',
      args: [marketId],
    }) as Promise<Lifecycle>,
    client.getBlock(),
    client.readContract({
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'ammState',
      args: [marketId],
    }) as Promise<AmmState>,
    client.readContract({
      address: ADDRESSES.lmsr,
      abi: incubatorLmsrAbi,
      functionName: 'terminalAccounting',
      args: [marketId],
    }) as Promise<TerminalAccounting>,
    client.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'isResolved',
      args: [questionId],
    }) as Promise<boolean>,
    client.readContract({
      address: ADDRESSES.oracle,
      abi: committeeOracleAbi,
      functionName: 'questionThreshold',
      args: [questionId],
    }) as Promise<bigint>,
    account
      ? (client.readContract({
          address: ADDRESSES.oracle,
          abi: committeeOracleAbi,
          functionName: 'isSnapshotMember',
          args: [questionId, account],
        }) as Promise<boolean>)
      : Promise.resolve(false),
    client.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'payoutNumerators',
      args: [conditionId, 0n],
    }) as Promise<bigint>,
    client.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'payoutNumerators',
      args: [conditionId, 1n],
    }) as Promise<bigint>,
    client.readContract({
      address: ADDRESSES.ctf,
      abi: conditionalTokensAbi,
      functionName: 'payoutDenominator',
      args: [conditionId],
    }) as Promise<bigint>,
    account
      ? (client.readContract({
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'balanceOf',
          args: [account, yesTokenId],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
    account
      ? (client.readContract({
          address: ADDRESSES.ctf,
          abi: conditionalTokensAbi,
          functionName: 'balanceOf',
          args: [account, noTokenId],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
    account
      ? (client.readContract({
          address: ADDRESSES.lmsr,
          abi: incubatorLmsrAbi,
          functionName: 'fundingShares',
          args: [marketId, account],
        }) as Promise<bigint>)
      : Promise.resolve(0n),
    client.readContract({
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
  const protocolSweepAvailableRaw = settlementEvents.protocolSweepCompleted
    ? 0n
    : ammState.protocolFeesAccruedRaw +
      (protocolPnlRaw - protocolPnlSweptRaw);
  const lifecycleState = Number(lifecycle[2]);
  const tradingEndsAt = market.tradingEndsAt;
  const chainTimestamp = Number(block.timestamp);

  return {
    creator: lifecycle[0],
    lifecycleState,
    chainTimestamp,
    tradingEndsAt,
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
    protocolSweepCompleted: settlementEvents.protocolSweepCompleted,
    protocolSweptRaw: BigInt(settlementEvents.protocolSweptRaw),
    closedOutAt: Number(terminal[8]),
  };
}

export function useSettlementStatus(
  market: Market,
  account?: Address,
  settlementEvents: IndexedSettlementEvents = EMPTY_SETTLEMENT_EVENTS,
) {
  return useQuery<SettlementStatus, Error>({
    queryKey: [
      'settlement',
      market.id,
      account,
      settlementEvents.protocolSweepCompleted,
      settlementEvents.protocolSweptRaw,
    ],
    queryFn: () => readSettlementStatus(market, account, settlementEvents),
    staleTime: ARC_READ_CACHE_MS,
    refetchInterval: ARC_READ_CACHE_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
