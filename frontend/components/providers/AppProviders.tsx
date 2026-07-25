'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { WagmiProvider, type State } from 'wagmi';

import { BackendLiveSync } from '@/lib/api/live';
import { getWagmiConfig } from '@/lib/chain/config';

interface AppProvidersProps {
  children: ReactNode;
  initialState?: State;
}

export function AppProviders({ children, initialState }: AppProvidersProps) {
  const [wagmiConfig] = useState(getWagmiConfig);
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider
      config={wagmiConfig}
      initialState={initialState}
      reconnectOnMount
    >
      <QueryClientProvider client={queryClient}>
        <BackendLiveSync />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
