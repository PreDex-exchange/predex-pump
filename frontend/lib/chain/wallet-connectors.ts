import type { EIP1193Provider } from 'viem';

export const METAMASK_CONNECTOR_ID = 'metaMaskSDK';
export const PREDEX_QA_CONNECTOR_ID = 'predexQa';

export type PredexQaProviderWindow = Window & {
  ethereum?: EIP1193Provider & {
    isPredexQaWallet?: boolean;
  };
};

export function hasPredexQaProvider(
  browserWindow: Window | undefined =
    typeof window === 'undefined' ? undefined : window,
) {
  return (
    (browserWindow as PredexQaProviderWindow | undefined)?.ethereum
      ?.isPredexQaWallet === true
  );
}
