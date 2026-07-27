import { ADDRESSES } from '@predex-pump/shared';
import oracleAbiJson from '@predex-pump/shared/abis/CommitteeOracleAdapterV2.json' with {
  type: 'json',
};
import ctfAbiJson from '@predex-pump/shared/abis/ConditionalTokens.json' with { type: 'json' };
import lmsrAbiJson from '@predex-pump/shared/abis/IncubatorLMSR.json' with { type: 'json' };
import registryAbiJson from '@predex-pump/shared/abis/IncubatorRegistry.json' with { type: 'json' };
import miniClobAbiJson from '@predex-pump/shared/abis/MiniCLOB.json' with { type: 'json' };
import type { Abi, Address } from 'viem';

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
] as const;

export const TRACKED_ADDRESSES = TRACKED_CONTRACTS.map(({ address }) => address);

export const CONTRACT_BY_ADDRESS = new Map(
  TRACKED_CONTRACTS.map((contract) => [contract.address.toLowerCase(), contract]),
);
