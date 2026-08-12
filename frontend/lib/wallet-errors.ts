export const WALLET_REQUEST_DECLINED_MESSAGE =
  'You declined the wallet request. Nothing was signed or sent.';

export function walletProviderErrorCode(error: unknown): number | null {
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  for (let index = 0; index < pending.length && index < 16; index += 1) {
    const current = pending[index];
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const value = current as {
      code?: unknown;
      cause?: unknown;
      error?: unknown;
    };
    const code =
      typeof value.code === 'number'
        ? value.code
        : typeof value.code === 'string' && /^-?\d+$/u.test(value.code)
          ? Number(value.code)
          : null;
    if (code !== null && Number.isSafeInteger(code)) return code;

    pending.push(value.cause, value.error);
  }

  return null;
}

/**
 * Converts wallet/provider failures into copy that is safe to render. Provider
 * messages are deliberately never used as a fallback: they can contain RPC
 * URLs, request bodies, duplicate clauses, and dependency versions.
 */
export function publicWalletErrorMessage(
  error: unknown,
  fallback: string,
): string {
  switch (walletProviderErrorCode(error)) {
    case 4001:
      return WALLET_REQUEST_DECLINED_MESSAGE;
    case 4100:
      return 'This wallet has not authorized the requested account access.';
    case 4200:
      return 'This wallet does not support the requested action.';
    case 4900:
      return 'The wallet is disconnected. Reconnect it and try again.';
    case 4901:
      return 'The wallet is not connected to Arc. Switch networks and try again.';
    case -32002:
      return 'A wallet request is already open. Check the wallet before trying again.';
    default:
      return fallback;
  }
}
