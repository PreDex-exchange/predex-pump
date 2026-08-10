import { ADDRESSES } from '@predex-pump/shared';
import oracleAbiJson from '@predex-pump/shared/abis/CommitteeOracleAdapterV2.json' with {
  type: 'json',
};
import ctfAbiJson from '@predex-pump/shared/abis/ConditionalTokens.json' with { type: 'json' };
import ctfExchangeAbiJson from '@predex-pump/shared/abis/CTFExchange.json' with { type: 'json' };
import collateralAbiJson from '@predex-pump/shared/abis/CollateralErc20.json' with { type: 'json' };
import lmsrAbiJson from '@predex-pump/shared/abis/IncubatorLMSR.json' with { type: 'json' };
import registryAbiJson from '@predex-pump/shared/abis/IncubatorRegistry.json' with { type: 'json' };
import miniClobAbiJson from '@predex-pump/shared/abis/MiniCLOB.json' with { type: 'json' };
import type { Abi, AbiEvent, Address } from 'viem';

import type { ContractSource } from './types.js';

export interface TrackedContract {
  source: ContractSource;
  address: Address;
  abi: Abi;
}

export const TRACKED_CONTRACTS: readonly TrackedContract[] = [
  {
    source: 'REGISTRY',
    address: ADDRESSES.registry,
    abi: registryAbiJson as Abi,
  },
  {
    source: 'LMSR',
    address: ADDRESSES.lmsr,
    abi: lmsrAbiJson as Abi,
  },
  {
    source: 'MINI_CLOB',
    address: ADDRESSES.miniClob,
    abi: miniClobAbiJson as Abi,
  },
  {
    source: 'CTF',
    address: ADDRESSES.ctf,
    abi: ctfAbiJson as Abi,
  },
  {
    source: 'ORACLE',
    address: ADDRESSES.oracle,
    abi: oracleAbiJson as Abi,
  },
  {
    source: 'CTF_EXCHANGE',
    address: ADDRESSES.ctfExchange,
    abi: ctfExchangeAbiJson as Abi,
  },
  {
    source: 'COLLATERAL',
    address: ADDRESSES.usdc,
    abi: collateralAbiJson as Abi,
  },
] as const;

export const CORE_TRACKED_ADDRESSES = TRACKED_CONTRACTS.filter(
  ({ source }) => source !== 'CTF' && source !== 'COLLATERAL',
).map(({ address }) => address);

export const CTF_EVENT_ABI = (ctfAbiJson as Abi).filter(
  (item): item is AbiEvent =>
    item.type === 'event' && item.name !== 'ApprovalForAll',
);

function eventFromAbi(abi: Abi, name: string): AbiEvent {
  const event = abi.find(
    (item): item is AbiEvent => item.type === 'event' && item.name === name,
  );
  if (event === undefined) throw new Error(`ABI is missing event ${name}`);
  return event;
}

export const CTF_APPROVAL_EVENT = eventFromAbi(
  ctfAbiJson as Abi,
  'ApprovalForAll',
);

export const COLLATERAL_APPROVAL_EVENT = eventFromAbi(
  collateralAbiJson as Abi,
  'Approval',
);

export const COLLATERAL_TRANSFER_EVENT = eventFromAbi(
  collateralAbiJson as Abi,
  'Transfer',
);

export const CONTRACT_BY_ADDRESS = new Map(
  TRACKED_CONTRACTS.map((contract) => [contract.address.toLowerCase(), contract]),
);
