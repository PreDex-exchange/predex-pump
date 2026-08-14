import {
  cookieStorage,
  createConfig,
  createStorage,
  http,
} from 'wagmi';
import { injected } from 'wagmi/connectors';

import { arcTestnet } from './arc';

// Market, book and position data all come from the indexed REST/WebSocket API,
// so the browser needs the chain only for wallet balance and for sending
// transactions. wagmi's 4s default block polling is therefore almost pure
// waste, and it competes with the indexer for the same Arc request budget —
// enough to starve it into `stalled` and freeze its head watermark.
const CHAIN_POLLING_INTERVAL_MS = 30_000;

function createWagmiConfig() {
  return createConfig({
    chains: [arcTestnet],
    connectors: [injected()],
    pollingInterval: CHAIN_POLLING_INTERVAL_MS,
    transports: {
      [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]),
    },
    storage: createStorage({
      storage: cookieStorage,
    }),
    ssr: true,
  });
}

let browserConfig: ReturnType<typeof createWagmiConfig> | undefined;

export function getWagmiConfig() {
  // Cookie hydration is request-specific on the server. In the browser, the
  // provider and imperative transaction actions must share one config store.
  if (typeof window === 'undefined') return createWagmiConfig();
  browserConfig ??= createWagmiConfig();
  return browserConfig;
}

// Imperative transaction actions and the browser provider share this instance.
export const wagmiConfig = getWagmiConfig();

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
