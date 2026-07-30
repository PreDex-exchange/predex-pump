import committeeOracleAbiJson from '@predex-pump/shared/abis/CommitteeOracleAdapterV2.json';
import conditionalTokensAbiJson from '@predex-pump/shared/abis/ConditionalTokens.json';
import incubatorLmsrAbiJson from '@predex-pump/shared/abis/IncubatorLMSR.json';
import incubatorRegistryAbiJson from '@predex-pump/shared/abis/IncubatorRegistry.json';
import miniClobAbiJson from '@predex-pump/shared/abis/MiniCLOB.json';
import { collateralErc20Abi } from '@predex-pump/shared/tx';
import type { Abi } from 'viem';

// The checked-in deployment ABIs are the runtime source of truth. Keeping the casts
// in one file prevents components and transaction helpers from drifting to hand-built
// incubator signatures.
export const committeeOracleAbi = committeeOracleAbiJson as Abi;
export const conditionalTokensAbi = conditionalTokensAbiJson as Abi;
export const incubatorLmsrAbi = incubatorLmsrAbiJson as Abi;
export const incubatorRegistryAbi = incubatorRegistryAbiJson as Abi;
export const miniClobAbi = miniClobAbiJson as Abi;
export { collateralErc20Abi };
