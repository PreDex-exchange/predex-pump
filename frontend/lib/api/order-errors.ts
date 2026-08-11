import type { OrderIngestRejectionCode } from '@predex-pump/shared/rest';

export const ORDER_REJECTION_MESSAGES = {
  BAD_SIGNATURE:
    'Your wallet signature could not be verified. Reconnect the intended maker wallet and sign the reviewed order again.',
  WRONG_NONCE:
    'Your exchange cancellation nonce changed before this order arrived. Refresh the book and create a new signature.',
  EXPIRED:
    'This order expired before it reached the book. Choose a later expiry and sign a fresh order.',
  INSUFFICIENT_BALANCE:
    'The maker wallet no longer has enough of the asset offered by this order. Reduce the size or add funds or tokens, then sign again.',
  MISSING_APPROVAL:
    'The exchange is not currently allowed to move the maker asset. Refresh approval status, grant only the approval shown, then retry.',
  MARKET_RESOLVED:
    'This market has resolved, so it can no longer accept orders. Review the settlement controls instead of signing again.',
  TOKEN_NOT_REGISTERED:
    'This position token is not registered with the exchange. Refresh the market and wait for venue setup before trying again.',
  INVALID_PRICE:
    'The limit price is outside the supported range. Enter a price above 0 and no more than 1 USDC per token.',
  PRICE_NOT_ON_TICK:
    'The limit price is not aligned to this market’s current tick size. Refresh the market and use one of the displayed price increments before signing again.',
  INVALID_SIZE:
    'The order size must be a positive multiple of 0.001 token. Correct the size, then review it again.',
  INVALID_FEE:
    'The signed fee does not match this venue’s fee policy. Refresh the page and create a new order with the current terms.',
  INVALID_TAKER:
    'This operator only lists orders that anyone may fill. Refresh and sign a public order instead of restricting the taker.',
  MALFORMED_ORDER:
    'The submitted order is missing or misformats required fields. Refresh the page and rebuild the order before signing again.',
  MARKET_NOT_FOUND:
    'The operator cannot find this market in its indexed deployment. Check the network and refresh the market before retrying.',
  ORDER_HASH_MISMATCH:
    'The signed fields do not match the submitted order identity. Discard this signature, refresh, and sign a newly built order.',
  SIGNER_UNAUTHORIZED:
    'The signing wallet is not authorized for the maker address. Switch to the maker wallet and sign the order again.',
  TOKEN_PAIR_MISMATCH:
    'The position token does not belong to this market’s YES/NO pair. Refresh the market before constructing another order.',
  UNSUPPORTED_SIGNATURE_TYPE:
    'This venue cannot verify the selected wallet signature format. Use the connected wallet’s standard EIP-712 signing flow.',
  CHAIN_READ_FAILED:
    'The operator could not verify current chain state safely. Wait for Arc reads to recover, refresh approvals, and retry without reusing the signature.',
} as const satisfies Record<OrderIngestRejectionCode, string>;

export function isOrderIngestRejectionCode(
  value: unknown,
): value is OrderIngestRejectionCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(ORDER_REJECTION_MESSAGES, value)
  );
}

export function humanizeOrderRejection(
  code: OrderIngestRejectionCode,
): string {
  return ORDER_REJECTION_MESSAGES[code];
}
