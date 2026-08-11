import {
  createWalletClient,
  getAddress,
  http,
  isAddress,
  isHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  ARC_CHAIN_ID,
  QA_WALLET_MODES,
  READ_ONLY_ERROR_MESSAGE,
} from './constants.mjs';

const ARC_CHAIN = {
  id: ARC_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        'https://rpc.testnet.arc.network',
        'https://rpc.drpc.testnet.arc.network',
      ],
    },
  },
  testnet: true,
};

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const INTEGER_FIELDS = [
  'gas',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'value',
];

export class QaWalletRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'QaWalletRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function invalidParams(message) {
  return new QaWalletRpcError(-32602, message);
}

function requiredPrivateKey(value) {
  if (typeof value !== 'string' || !PRIVATE_KEY_PATTERN.test(value)) {
    throw new Error(
      'QA_WALLET_PRIVATE_KEY must be set at runtime to a 0x-prefixed 32-byte private key.',
    );
  }
  try {
    return privateKeyToAccount(value);
  } catch {
    throw new Error('QA_WALLET_PRIVATE_KEY is not a valid secp256k1 private key.');
  }
}

function walletMode(value) {
  if (value === undefined || value === '' || value === QA_WALLET_MODES.READ_ONLY) {
    return QA_WALLET_MODES.READ_ONLY;
  }
  if (value === QA_WALLET_MODES.BROADCAST) return QA_WALLET_MODES.BROADCAST;
  throw new Error('QA_WALLET_MODE must be read-only or broadcast.');
}

function assertRequestedAccount(value, account) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw invalidParams('The signing account is missing or invalid.');
  }
  if (getAddress(value) !== getAddress(account.address)) {
    throw new QaWalletRpcError(4100, 'The requested account is not exposed by this QA wallet.');
  }
}

function personalSignInput(params, account) {
  if (!Array.isArray(params) || params.length < 2) {
    throw invalidParams('personal_sign requires a message and account.');
  }
  const first = params[0];
  const second = params[1];
  // A 20-byte hex message can look exactly like an address. Prefer the
  // standard [message, account] ordering when the second value is our account.
  const secondIsAccount =
    typeof second === 'string' &&
    isAddress(second) &&
    getAddress(second) === getAddress(account.address);
  const addressFirst =
    !secondIsAccount && typeof first === 'string' && isAddress(first);
  const requestedAccount = addressFirst ? first : second;
  const message = addressFirst ? second : first;
  assertRequestedAccount(requestedAccount, account);
  if (typeof message !== 'string') {
    throw invalidParams('personal_sign message must be a string.');
  }
  return isHex(message) ? { raw: message } : message;
}

function typedDataInput(params, account) {
  if (!Array.isArray(params) || params.length < 2) {
    throw invalidParams('eth_signTypedData_v4 requires an account and typed data.');
  }
  assertRequestedAccount(params[0], account);
  let typedData = params[1];
  if (typeof typedData === 'string') {
    try {
      typedData = JSON.parse(typedData);
    } catch {
      throw invalidParams('eth_signTypedData_v4 typed data must be valid JSON.');
    }
  }
  if (
    typeof typedData !== 'object' ||
    typedData === null ||
    Array.isArray(typedData) ||
    typeof typedData.primaryType !== 'string' ||
    typeof typedData.types !== 'object' ||
    typedData.types === null ||
    typeof typedData.message !== 'object' ||
    typedData.message === null
  ) {
    throw invalidParams('eth_signTypedData_v4 payload is incomplete.');
  }
  const chainId = typedData.domain?.chainId;
  if (chainId !== undefined) {
    let parsedChainId;
    try {
      parsedChainId = Number(BigInt(chainId));
    } catch {
      throw invalidParams('EIP-712 domain chainId is invalid.');
    }
    if (parsedChainId !== ARC_CHAIN_ID) {
      throw new QaWalletRpcError(4901, 'The QA wallet signs Arc testnet typed data only.');
    }
  }
  return typedData;
}

function rpcQuantity(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/u.test(value)) {
    throw invalidParams(`${field} must be a hexadecimal RPC quantity.`);
  }
  return BigInt(value);
}

function transactionInput(params, account) {
  if (!Array.isArray(params) || params.length !== 1) {
    throw invalidParams('eth_sendTransaction requires exactly one transaction.');
  }
  const input = params[0];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidParams('eth_sendTransaction transaction must be an object.');
  }
  assertRequestedAccount(input.from, account);
  if (input.chainId !== undefined) {
    const chainId = Number(rpcQuantity(input.chainId, 'chainId'));
    if (chainId !== ARC_CHAIN_ID) {
      throw new QaWalletRpcError(4901, 'The QA wallet broadcasts on Arc testnet only.');
    }
  }
  if (input.to !== undefined && (typeof input.to !== 'string' || !isAddress(input.to))) {
    throw invalidParams('Transaction to must be an address.');
  }
  const data = input.data ?? input.input;
  if (data !== undefined && (typeof data !== 'string' || !isHex(data))) {
    throw invalidParams('Transaction data must be hex encoded.');
  }

  const transaction = {
    account,
    chain: ARC_CHAIN,
    ...(input.to === undefined ? {} : { to: getAddress(input.to) }),
    ...(data === undefined ? {} : { data }),
    ...(input.accessList === undefined ? {} : { accessList: input.accessList }),
  };
  for (const field of INTEGER_FIELDS) {
    if (input[field] !== undefined) {
      transaction[field] = rpcQuantity(input[field], field);
    }
  }
  if (input.nonce !== undefined) {
    const nonce = rpcQuantity(input.nonce, 'nonce');
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalidParams('Transaction nonce is too large.');
    }
    transaction.nonce = Number(nonce);
  }
  return transaction;
}

export function createQaWalletService({
  privateKey,
  mode = QA_WALLET_MODES.READ_ONLY,
  rpcUrl = ARC_CHAIN.rpcUrls.default.http[0],
  broadcastTransaction,
}) {
  const account = requiredPrivateKey(privateKey);
  const resolvedMode = walletMode(mode);
  let sendTransaction = broadcastTransaction;

  async function request(method, params = []) {
    switch (method) {
      case 'personal_sign':
        return account.signMessage({ message: personalSignInput(params, account) });
      case 'eth_signTypedData_v4':
        return account.signTypedData(typedDataInput(params, account));
      case 'eth_sendTransaction': {
        // This branch runs before a wallet client or transport is created, so
        // read-only mode cannot make a chain request by accident.
        if (resolvedMode === QA_WALLET_MODES.READ_ONLY) {
          throw new QaWalletRpcError(4100, READ_ONLY_ERROR_MESSAGE);
        }
        const transaction = transactionInput(params, account);
        sendTransaction ??= (requestToSend) =>
          createWalletClient({
            account,
            chain: ARC_CHAIN,
            transport: http(rpcUrl),
          }).sendTransaction(requestToSend);
        return sendTransaction(transaction);
      }
      default:
        throw new QaWalletRpcError(4200, `Unsupported QA wallet method ${method}.`);
    }
  }

  return {
    account: account.address,
    mode: resolvedMode,
    request,
  };
}

export function loadQaWalletService(env = process.env, overrides = {}) {
  return createQaWalletService({
    privateKey: env.QA_WALLET_PRIVATE_KEY,
    mode: env.QA_WALLET_MODE,
    rpcUrl:
      env.ARC_RPC_URL?.trim() || ARC_CHAIN.rpcUrls.default.http[0],
    ...overrides,
  });
}
