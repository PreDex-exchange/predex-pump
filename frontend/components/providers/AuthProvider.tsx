'use client';

import type { SessionResponse } from '@predex-pump/shared/rest';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Address } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { useAccount, useSignMessage } from 'wagmi';

import { backendRestClient } from '@/lib/api/rest-client';
import { publicWalletErrorMessage } from '@/lib/wallet-errors';

const AUTH_SESSION_QUERY_KEY = ['auth-session'] as const;
const ANONYMOUS_SESSION: SessionResponse = { authenticated: false };

interface AuthContextValue {
  session: SessionResponse | null;
  isLoading: boolean;
  isEstablishingSession: boolean;
  error: Error | null;
  ensureSession: () => Promise<boolean>;
  clearSession: () => Promise<void>;
  refetch: () => void;
}

const missingSessionProvider = async () => {
  throw new Error('Account provider is unavailable.');
};

const AuthContext = createContext<AuthContextValue>({
  session: null,
  isLoading: false,
  isEstablishingSession: false,
  error: null,
  ensureSession: missingSessionProvider,
  clearSession: missingSessionProvider,
  refetch: () => undefined,
});

function addressKey(address: Address | undefined) {
  return address?.toLowerCase() ?? null;
}

function sessionMatchesAddress(
  session: SessionResponse | undefined,
  address: Address,
) {
  return (
    session?.authenticated === true &&
    session.address.toLowerCase() === address.toLowerCase()
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { address, isConnected, status } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const connectedAddress = isConnected ? address : undefined;
  const connectedAddressKey = addressKey(connectedAddress);
  const currentAddressRef = useRef<Address | undefined>(connectedAddress);
  const previousAddressRef = useRef<Address | undefined>(connectedAddress);
  // Refetches and reconnects may rerender indefinitely; an address gets only
  // one automatic wallet prompt until a feature explicitly requests a retry.
  const attemptedAddressesRef = useRef(new Set<string>());
  const inFlightAttemptsRef = useRef(new Map<string, Promise<boolean>>());
  // Keep account changes and disconnects behind any older wallet prompt so a
  // late verification can never win over the currently connected address.
  const authQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const clearInFlightRef = useRef<Promise<void> | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [establishingAddress, setEstablishingAddress] = useState<string | null>(
    null,
  );

  useEffect(() => {
    currentAddressRef.current = connectedAddress;
  }, [connectedAddress]);

  const sessionQuery = useQuery<SessionResponse, Error>({
    queryKey: AUTH_SESSION_QUERY_KEY,
    queryFn: () => backendRestClient.getSession(),
    retry: false,
    staleTime: 60_000,
  });

  const enqueueAuthWork = useCallback(
    (operation: () => Promise<boolean>): Promise<boolean> => {
      const queued = authQueueRef.current.then(operation, operation);
      authQueueRef.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [],
  );

  const requestSessionForAddress = useCallback(
    (targetAddress: Address, allowRetry: boolean): Promise<boolean> => {
      const targetKey = targetAddress.toLowerCase();
      const currentSession = queryClient.getQueryData<SessionResponse>(
        AUTH_SESSION_QUERY_KEY,
      );
      if (
        addressKey(currentAddressRef.current) === targetKey &&
        sessionMatchesAddress(currentSession, targetAddress)
      ) {
        return Promise.resolve(true);
      }

      const inFlight = inFlightAttemptsRef.current.get(targetKey);
      if (inFlight) return inFlight;
      if (!allowRetry && attemptedAddressesRef.current.has(targetKey)) {
        return Promise.resolve(false);
      }
      attemptedAddressesRef.current.add(targetKey);

      const request = enqueueAuthWork(async () => {
        if (addressKey(currentAddressRef.current) !== targetKey) return false;
        setActionError(null);
        setEstablishingAddress(targetKey);
        try {
          const savedSession = queryClient.getQueryData<SessionResponse>(
            AUTH_SESSION_QUERY_KEY,
          );
          if (sessionMatchesAddress(savedSession, targetAddress)) return true;

          if (savedSession?.authenticated === true) {
            const anonymousSession = await backendRestClient.signOut();
            queryClient.setQueryData(
              AUTH_SESSION_QUERY_KEY,
              anonymousSession,
            );
            queryClient.removeQueries({ queryKey: ['account-profile'] });
          }
          if (addressKey(currentAddressRef.current) !== targetKey) return false;

          const nonce = await backendRestClient.getSiweNonce();
          if (addressKey(currentAddressRef.current) !== targetKey) return false;
          const message = createSiweMessage({
            address: targetAddress,
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
          if (addressKey(currentAddressRef.current) !== targetKey) return false;
          const verifiedSession = await backendRestClient.verifySiwe({
            message,
            signature,
          });

          if (addressKey(currentAddressRef.current) !== targetKey) {
            try {
              await backendRestClient.signOut();
            } finally {
              queryClient.setQueryData(
                AUTH_SESSION_QUERY_KEY,
                ANONYMOUS_SESSION,
              );
              queryClient.removeQueries({ queryKey: ['account-profile'] });
            }
            return false;
          }
          if (!sessionMatchesAddress(verifiedSession, targetAddress)) {
            throw new Error('The prepared account session did not match this wallet.');
          }

          queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, verifiedSession);
          await queryClient.invalidateQueries({ queryKey: ['account-profile'] });
          return true;
        } catch (error) {
          if (addressKey(currentAddressRef.current) === targetKey) {
            setActionError(
              new Error(
                publicWalletErrorMessage(
                  error,
                  'The account session could not be prepared. Your wallet stays connected, and trading remains available.',
                ),
              ),
            );
          }
          return false;
        } finally {
          setEstablishingAddress((current) =>
            current === targetKey ? null : current,
          );
        }
      });

      inFlightAttemptsRef.current.set(targetKey, request);
      const removeInFlightAttempt = () => {
        if (inFlightAttemptsRef.current.get(targetKey) === request) {
          inFlightAttemptsRef.current.delete(targetKey);
        }
      };
      void request.then(removeInFlightAttempt, removeInFlightAttempt);
      return request;
    },
    [enqueueAuthWork, queryClient, signMessageAsync],
  );

  const ensureSession = useCallback(async () => {
    const currentAddress = currentAddressRef.current;
    if (!currentAddress) {
      setActionError(
        new Error('Connect a wallet to use saved account features.'),
      );
      return false;
    }
    return requestSessionForAddress(currentAddress, true);
  }, [requestSessionForAddress]);

  const clearSession = useCallback((): Promise<void> => {
    const currentKey = addressKey(currentAddressRef.current);
    if (currentKey) attemptedAddressesRef.current.add(currentKey);
    const inFlight = clearInFlightRef.current;
    if (inFlight) return inFlight;

    const request = enqueueAuthWork(async () => {
      setActionError(null);
      try {
        const anonymousSession = await backendRestClient.signOut();
        queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, anonymousSession);
        queryClient.removeQueries({ queryKey: ['account-profile'] });
        return true;
      } catch {
        queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, ANONYMOUS_SESSION);
        queryClient.removeQueries({ queryKey: ['account-profile'] });
        setActionError(
          new Error(
            'The saved account session could not be cleared. Reconnect and disconnect the wallet to try again.',
          ),
        );
        return false;
      }
    }).then(() => undefined);

    clearInFlightRef.current = request;
    const removeInFlightClear = () => {
      if (clearInFlightRef.current === request) {
        clearInFlightRef.current = null;
      }
    };
    void request.then(removeInFlightClear, removeInFlightClear);
    return request;
  }, [enqueueAuthWork, queryClient]);

  useEffect(() => {
    if (!sessionQuery.isFetched || !connectedAddress) return;
    if (sessionMatchesAddress(sessionQuery.data, connectedAddress)) return;
    void requestSessionForAddress(connectedAddress, false);
  }, [
    connectedAddress,
    requestSessionForAddress,
    sessionQuery.data,
    sessionQuery.isFetched,
  ]);

  useEffect(() => {
    const previousAddress = previousAddressRef.current;
    previousAddressRef.current = connectedAddress;
    if (previousAddress && !connectedAddress) void clearSession();
  }, [clearSession, connectedAddress]);

  useEffect(() => {
    if (
      status === 'disconnected' &&
      sessionQuery.isSuccess &&
      sessionQuery.data.authenticated
    ) {
      void clearSession();
    }
  }, [clearSession, sessionQuery.data, sessionQuery.isSuccess, status]);

  const walletSession = useMemo<SessionResponse | null>(() => {
    const savedSession = sessionQuery.data;
    if (!savedSession) return null;
    if (!savedSession.authenticated) return savedSession;
    if (
      connectedAddress &&
      sessionMatchesAddress(savedSession, connectedAddress)
    ) {
      return savedSession;
    }
    return ANONYMOUS_SESSION;
  }, [connectedAddress, sessionQuery.data]);
  const isEstablishingSession =
    connectedAddressKey !== null && establishingAddress === connectedAddressKey;

  const value = useMemo<AuthContextValue>(
    () => ({
      session: walletSession,
      isLoading: sessionQuery.isLoading || isEstablishingSession,
      isEstablishingSession,
      error:
        actionError ??
        (sessionQuery.error
          ? new Error('The saved account session could not be restored. Try again.')
          : null),
      ensureSession,
      clearSession,
      refetch: () => {
        void sessionQuery.refetch();
      },
    }),
    [
      actionError,
      clearSession,
      ensureSession,
      isEstablishingSession,
      sessionQuery,
      walletSession,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
