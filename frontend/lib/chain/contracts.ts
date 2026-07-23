import committeeOracleAbiJson from '@predex-pump/shared/abis/CommitteeOracleAdapterV2.json';
import conditionalTokensAbiJson from '@predex-pump/shared/abis/ConditionalTokens.json';
import incubatorLmsrAbiJson from '@predex-pump/shared/abis/IncubatorLMSR.json';
import incubatorRegistryAbiJson from '@predex-pump/shared/abis/IncubatorRegistry.json';
import miniClobAbiJson from '@predex-pump/shared/abis/MiniCLOB.json';
import type { Abi } from 'viem';

// The checked-in deployment ABIs are the runtime source of truth. Keeping the casts
// in one file prevents components and transaction helpers from drifting to hand-built
// incubator signatures.
export const committeeOracleAbi = committeeOracleAbiJson as Abi;
export const conditionalTokensAbi = conditionalTokensAbiJson as Abi;
export const incubatorLmsrAbi = incubatorLmsrAbiJson as Abi;
export const incubatorRegistryAbi = incubatorRegistryAbiJson as Abi;
export const miniClobAbi = miniClobAbiJson as Abi;

// Arc collateral is used strictly through this six-decimal ERC-20 surface.
export const collateralErc20Abi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;
