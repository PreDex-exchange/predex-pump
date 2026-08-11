'use client';

import type { SessionResponse } from '@predex-pump/shared/rest';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createSiweMessage } from 'viem/siwe';
import { useAccount, useSignMessage } from 'wagmi';

import { backendRestClient } from '@/lib/api/rest-client';
import { publicWalletErrorMessage } from '@/lib/wallet-errors';

interface AuthContextValue {
  session: SessionResponse | null;
  isLoading: boolean;
  isSigningIn: boolean;
  error: Error | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refetch: () => void;
}

const missingProvider = async () => {
  throw new Error('Account provider is unavailable.');
};

const AuthContext = createContext<AuthContextValue>({
  session: null,
  isLoading: false,
  isSigningIn: false,
  error: null,
  signIn: missingProvider,
  signOut: missingProvider,
  refetch: () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [actionError, setActionError] = useState<Error | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const sessionQuery = useQuery<SessionResponse, Error>({
    queryKey: ['auth-session'],
    queryFn: () => backendRestClient.getSession(),
    retry: false,
    staleTime: 60_000,
  });

  const signIn = useCallback(async () => {
    if (!isConnected || !address) {
      setActionError(new Error('Connect a wallet before signing in.'));
      return;
    }
    setActionError(null);
    setIsSigningIn(true);
    try {
      const nonce = await backendRestClient.getSiweNonce();
      const message = createSiweMessage({
        address,
        chainId: nonce.chainId,
        domain: nonce.domain,
        uri: nonce.uri,
        version: '1',
        statement: nonce.statement,
        nonce: nonce.nonce,
        issuedAt: new Date(nonce.issuedAt),
        expirationTime: new Date(nonce.expirationTime),
      });
      const signature = await signMessageAsync({ message });
      const session = await backendRestClient.verifySiwe({ message, signature });
      queryClient.setQueryData(['auth-session'], session);
      await queryClient.invalidateQueries({ queryKey: ['account-profile'] });
    } catch (error) {
      setActionError(
        new Error(
          publicWalletErrorMessage(
            error,
            'Wallet sign-in did not complete. Check the connection and try again.',
          ),
        ),
      );
    } finally {
      setIsSigningIn(false);
    }
  }, [address, isConnected, queryClient, signMessageAsync]);

  const signOut = useCallback(async () => {
    setActionError(null);
    try {
      const session = await backendRestClient.signOut();
      queryClient.setQueryData(['auth-session'], session);
      queryClient.removeQueries({ queryKey: ['account-profile'] });
    } catch {
      setActionError(new Error('Sign-out did not complete. Try again.'));
    }
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session: sessionQuery.data ?? null,
      isLoading: sessionQuery.isLoading,
      isSigningIn,
      error:
        actionError ??
        (sessionQuery.error
          ? new Error('The saved account session could not be restored. Try again.')
          : null),
      signIn,
      signOut,
      refetch: () => {
        void sessionQuery.refetch();
      },
    }),
    [actionError, isSigningIn, sessionQuery, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
