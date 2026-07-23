'use client';

import { useCallback, useState } from 'react';

import {
  chainErrorMessage,
  type TxProgress,
  type TxReporter,
} from './transactions';

const INITIAL_STATE: TxProgress = {
  phase: 'idle',
  message: 'Ready.',
};

export function useTxFlow() {
  const [state, setState] = useState<TxProgress>(INITIAL_STATE);

  const execute = useCallback(
    async <T,>(operation: (report: TxReporter) => Promise<T>) => {
      setState({
        phase: 'checking',
        message: 'Reading transaction-critical state from Arc…',
      });
      try {
        return await operation(setState);
      } catch (error) {
        const message = chainErrorMessage(error);
        setState((current) => ({
          phase: 'reverted',
          message: 'The transaction did not complete.',
          hash: current.hash,
          error: message,
        }));
        return null;
      }
    },
    [],
  );

  const reset = useCallback(() => setState(INITIAL_STATE), []);
  const isBusy =
    state.phase !== 'idle' &&
    state.phase !== 'confirmed' &&
    state.phase !== 'reverted';

  return { state, execute, reset, isBusy };
}
