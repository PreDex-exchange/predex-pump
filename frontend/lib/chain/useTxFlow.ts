'use client';

import { useCallback, useRef, useState } from 'react';

import {
  OnchainTransactionRevertedError,
  type TxProgress,
  type TxReporter,
} from './transactions';
import {
  publicWalletErrorMessage,
  walletProviderErrorCode,
} from '../wallet-errors';

const INITIAL_STATE: TxProgress = {
  phase: 'idle',
  message: 'Ready.',
};

export interface TxFlowOptions {
  checkingMessage?: string;
  failureMessage?: string;
  failurePhase?: 'rejected' | 'failed';
}

function hasNestedErrorName(error: unknown, names: ReadonlySet<string>) {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let index = 0; index < pending.length && index < 16; index += 1) {
    const currentError = pending[index];
    if (
      typeof currentError !== 'object' ||
      currentError === null ||
      seen.has(currentError)
    ) {
      continue;
    }
    seen.add(currentError);
    const nested = currentError as {
      name?: unknown;
      cause?: unknown;
      error?: unknown;
    };
    if (typeof nested.name === 'string' && names.has(nested.name)) return true;
    pending.push(nested.cause, nested.error);
  }
  return false;
}

function failedProgress(
  error: unknown,
  current: TxProgress,
  options: TxFlowOptions,
): TxProgress {
  const code = walletProviderErrorCode(error);
  if (code === 4001 || code === 4100 || code === 4200) {
    return {
      phase: 'rejected',
      message:
        code === 4001 && current.hash
          ? 'You declined the wallet request. The earlier transaction was sent, but no additional transaction was signed or sent.'
          : publicWalletErrorMessage(
              error,
              'The wallet refused this request. Nothing was signed or sent.',
            ),
      hash: current.hash,
    };
  }
  if (code === 4900 || code === 4901 || code === -32002) {
    return {
      phase: 'failed',
      message: publicWalletErrorMessage(
        error,
        'The wallet connection failed before the action was confirmed.',
      ),
      hash: current.hash,
    };
  }
  if (error instanceof OnchainTransactionRevertedError) {
    return {
      phase: 'reverted',
      message: error.message,
      hash: error.hash,
    };
  }
  if (options.failureMessage || options.failurePhase) {
    return {
      phase: options.failurePhase ?? 'failed',
      message: options.failureMessage ?? 'The action failed before confirmation.',
      hash: current.hash,
    };
  }
  if (
    !current.hash &&
    (current.phase === 'awaiting-transaction' ||
      current.phase === 'awaiting-approval') &&
    hasNestedErrorName(error, new Set(['TransportTimeoutError']))
  ) {
    return {
      phase: 'submission-unknown',
      message:
        'The wallet stopped waiting before returning a transaction hash. The transaction may still have been submitted or confirmed on Arc. Close this dialog and check Activity or the affected market before retrying.',
    };
  }
  const transportFailure = hasNestedErrorName(
    error,
    new Set([
      'FetchError',
      'HttpRequestError',
      'NetworkError',
      'TimeoutError',
      'WebSocketRequestError',
    ]),
  );
  return {
    phase: 'failed',
    message: current.hash
      ? 'Arc could not confirm the submitted transaction. Check its transaction hash before retrying.'
      : transportFailure
        ? 'The wallet-to-Arc connection failed before submission. Nothing was confirmed on-chain.'
        : 'The action failed before a transaction was confirmed. Nothing was reported as reverted on-chain.',
    hash: current.hash,
  };
}

export function useTxFlow() {
  const [state, setState] = useState<TxProgress>(INITIAL_STATE);
  const progressRef = useRef<TxProgress>(INITIAL_STATE);

  const report = useCallback<TxReporter>((progress) => {
    progressRef.current = progress;
    setState(progress);
  }, []);

  const execute = useCallback(
    async <T,>(
      operation: (report: TxReporter) => Promise<T>,
      options: TxFlowOptions = {},
    ) => {
      if (progressRef.current.phase === 'submission-unknown') return null;

      report({
        phase: 'checking',
        message:
          options.checkingMessage ??
          'Reading transaction-critical state from Arc…',
      });
      try {
        return await operation(report);
      } catch (error) {
        report(failedProgress(error, progressRef.current, options));
        return null;
      }
    },
    [report],
  );

  const reset = useCallback(() => {
    if (progressRef.current.phase === 'submission-unknown') return;
    report(INITIAL_STATE);
  }, [report]);
  const isBusy =
    state.phase !== 'idle' &&
    state.phase !== 'confirmed' &&
    state.phase !== 'rejected' &&
    state.phase !== 'submission-unknown' &&
    state.phase !== 'failed' &&
    state.phase !== 'reverted';

  return { state, execute, reset, isBusy };
}
