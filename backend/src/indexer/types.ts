import type { OrderSide, Outcome } from '@predex-pump/shared';
import type { Address, Hex } from 'viem';

export type ContractSource = 'REGISTRY' | 'LMSR' | 'MINI_CLOB' | 'CTF' | 'ORACLE';
export type EventArgs = Record<string, unknown>;

export interface DecodedEvent {
  source: ContractSource;
  address: Address;
  eventName: string;
  args: EventArgs;
  txHash: Hex;
  logIndex: number;
  blockNumber: number;
  ts: number;
}

export type { Outcome };
export type Side = OrderSide;
