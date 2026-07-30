import committeeOracleAbiJson from '../../abis/CommitteeOracleAdapterV2.json' with {
  type: 'json',
};
import collateralErc20AbiJson from '../../abis/CollateralErc20.json' with {
  type: 'json',
};
import conditionalTokensAbiJson from '../../abis/ConditionalTokens.json' with {
  type: 'json',
};
import incubatorLmsrAbiJson from '../../abis/IncubatorLMSR.json' with {
  type: 'json',
};
import incubatorRegistryAbiJson from '../../abis/IncubatorRegistry.json' with {
  type: 'json',
};
import miniClobAbiJson from '../../abis/MiniCLOB.json' with { type: 'json' };
import type { Abi } from 'viem';

type CollateralErc20Abi = readonly [
  {
    readonly type: 'function';
    readonly name: 'allowance';
    readonly stateMutability: 'view';
    readonly inputs: readonly [
      { readonly name: 'owner'; readonly type: 'address' },
      { readonly name: 'spender'; readonly type: 'address' },
    ];
    readonly outputs: readonly [{ readonly name: ''; readonly type: 'uint256' }];
  },
  {
    readonly type: 'function';
    readonly name: 'approve';
    readonly stateMutability: 'nonpayable';
    readonly inputs: readonly [
      { readonly name: 'spender'; readonly type: 'address' },
      { readonly name: 'amount'; readonly type: 'uint256' },
    ];
    readonly outputs: readonly [{ readonly name: ''; readonly type: 'bool' }];
  },
  {
    readonly type: 'function';
    readonly name: 'balanceOf';
    readonly stateMutability: 'view';
    readonly inputs: readonly [
      { readonly name: 'account'; readonly type: 'address' },
    ];
    readonly outputs: readonly [{ readonly name: ''; readonly type: 'uint256' }];
  },
  {
    readonly type: 'function';
    readonly name: 'decimals';
    readonly stateMutability: 'view';
    readonly inputs: readonly [];
    readonly outputs: readonly [{ readonly name: ''; readonly type: 'uint8' }];
  },
];

export const committeeOracleAbi = committeeOracleAbiJson as Abi;
export const collateralErc20Abi =
  collateralErc20AbiJson as unknown as CollateralErc20Abi;
export const conditionalTokensAbi = conditionalTokensAbiJson as Abi;
export const incubatorLmsrAbi = incubatorLmsrAbiJson as Abi;
export const incubatorRegistryAbi = incubatorRegistryAbiJson as Abi;
export const miniClobAbi = miniClobAbiJson as Abi;
