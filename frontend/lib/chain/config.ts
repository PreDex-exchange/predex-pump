import {
  cookieStorage,
  createConfig,
  createStorage,
  http,
} from 'wagmi';
import { injected } from 'wagmi/connectors';

import { arcTestnet } from './arc';

function createWagmiConfig() {
  return createConfig({
    chains: [arcTestnet],
    connectors: [injected()],
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
