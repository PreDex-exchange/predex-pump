export const ARC_CHAIN_ID = 5_042_002;
export const ARC_CHAIN_ID_HEX = '0x4cef52';
export const QA_PROVIDER_MARKER = 'PREDEX_QA_INJECTED_PROVIDER_V1';
export const READ_ONLY_ERROR_MESSAGE =
  'QA wallet is in read-only mode; eth_sendTransaction is disabled and no transaction was broadcast.';

export const QA_WALLET_MODES = Object.freeze({
  READ_ONLY: 'read-only',
  BROADCAST: 'broadcast',
});
