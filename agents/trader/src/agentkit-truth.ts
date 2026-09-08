import {
  createCircleX402PaymentProvider,
  createTruthClient,
  type TruthClient,
} from '@predex-pump/agent-sdk';
import { ARC } from '@predex-pump/shared';
import { createAgentkitClient } from '@worldcoin/agentkit';
import type { PrivateKeyAccount } from 'viem';

export interface AgentkitTruthClientOptions {
  account: PrivateKeyAccount;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

/** World human-backed access first; the existing bounded Circle payment second. */
export function createAgentkitTruthClient({
  account,
  baseUrl,
  fetch: fetchOverride,
}: AgentkitTruthClientOptions): TruthClient {
  const agentkit = createAgentkitClient({
    ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
    signer: {
      address: account.address,
      chainId: `eip155:${ARC.chainId}`,
      type: 'eip191',
      signMessage: (message) => account.signMessage({ message }),
    },
  });
  return createTruthClient({
    baseUrl,
    fetch: agentkit.fetch,
    paymentProvider: createCircleX402PaymentProvider(account),
  });
}
