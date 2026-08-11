import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  getAddress,
  http,
  recoverMessageAddress,
  recoverTypedDataAddress,
  stringToHex,
  zeroAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from 'wagmi';
import { connect } from 'wagmi/actions';
import { injected } from 'wagmi/connectors';

import {
  ARC_CHAIN_ID,
  ARC_CHAIN_ID_HEX,
  QA_WALLET_MODES,
  READ_ONLY_ERROR_MESSAGE,
} from './constants.mjs';
import { startQaWalletServer } from './server.mjs';
import { loadQaWalletService } from './wallet-service.mjs';

const providerSource = await readFile(
  path.join(process.cwd(), 'qa', 'injected-provider.js'),
  'utf8',
);

const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
};

function runtimeEnv(privateKey, mode = QA_WALLET_MODES.READ_ONLY) {
  return {
    NODE_ENV: 'development',
    QA_WALLET_PRIVATE_KEY: privateKey,
    QA_WALLET_MODE: mode,
    QA_WALLET_ALLOWED_ORIGIN: 'http://127.0.0.1:3002',
  };
}

function installProvider({ account, mode, fetchImpl = vi.fn() }) {
  delete globalThis.ethereum;
  globalThis.__PREDEX_QA_WALLET_CONFIG__ = {
    account,
    chainId: ARC_CHAIN_ID,
    chainIdHex: ARC_CHAIN_ID_HEX,
    mode,
    rpcUrl: 'http://127.0.0.1:3003/rpc',
    token: 'ephemeral-test-capability',
  };
  vi.stubGlobal('fetch', fetchImpl);
  globalThis.eval(providerSource);
  return globalThis.ethereum;
}

function signerFetch(wallet) {
  return vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    try {
      const result = await wallet.request(body.method, body.params);
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: {
            code: Number.isInteger(error.code) ? error.code : -32603,
            message: error.message,
          },
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
  });
}

afterEach(() => {
  delete globalThis.ethereum;
  delete globalThis.__PREDEX_QA_WALLET_CONFIG__;
  vi.unstubAllGlobals();
});

describe('QA injected provider', () => {
  it('surfaces the runtime account and Arc chain ID', async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey).address;
    const fetchImpl = vi.fn();
    const provider = installProvider({
      account,
      mode: QA_WALLET_MODES.READ_ONLY,
      fetchImpl,
    });

    await expect(provider.request({ method: 'eth_chainId' })).resolves.toBe(
      ARC_CHAIN_ID_HEX,
    );
    await expect(provider.request({ method: 'eth_accounts' })).resolves.toEqual([
      account,
    ]);
    await expect(
      provider.request({ method: 'eth_requestAccounts' }),
    ).resolves.toEqual([account]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('connects through wagmi injected() as the configured Arc account', async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey).address;
    installProvider({ account, mode: QA_WALLET_MODES.READ_ONLY });
    const arc = {
      id: ARC_CHAIN_ID,
      name: 'Arc Testnet',
      nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
      testnet: true,
    };
    const config = createConfig({
      chains: [arc],
      connectors: [injected()],
      storage: null,
      transports: { [ARC_CHAIN_ID]: http() },
    });

    const connection = await connect(config, {
      connector: config.connectors[0],
    });

    expect(connection.accounts).toEqual([account]);
    expect(connection.chainId).toBe(ARC_CHAIN_ID);
  });

  it('personal_sign produces a signature that recovers to the runtime account', async () => {
    const privateKey = generatePrivateKey();
    const wallet = loadQaWalletService(runtimeEnv(privateKey));
    const provider = installProvider({
      account: wallet.account,
      mode: wallet.mode,
      fetchImpl: signerFetch(wallet),
    });
    const message = stringToHex('Sign in to Predex QA');

    const signature = await provider.request({
      method: 'personal_sign',
      params: [message, wallet.account],
    });
    const recovered = await recoverMessageAddress({
      message: { raw: message },
      signature,
    });

    expect(getAddress(recovered)).toBe(wallet.account);
  });

  it('signs and recovers a representative CTFExchange EIP-712 order', async () => {
    const privateKey = generatePrivateKey();
    const wallet = loadQaWalletService(runtimeEnv(privateKey));
    const provider = installProvider({
      account: wallet.account,
      mode: wallet.mode,
      fetchImpl: signerFetch(wallet),
    });
    const typedData = {
      domain: {
        name: 'Predex CTFExchange',
        version: '1',
        chainId: ARC_CHAIN_ID,
        verifyingContract: '0x1d9637E0398f31d18c6792b7639ca47FC9B9c403',
      },
      types: ORDER_TYPES,
      primaryType: 'Order',
      message: {
        salt: 42n,
        maker: wallet.account,
        signer: wallet.account,
        taker: zeroAddress,
        tokenId: 7n,
        makerAmount: 500_000n,
        takerAmount: 1_000_000n,
        expiration: 1_900_000_000n,
        nonce: 3n,
        feeRateBps: 0n,
        side: 0,
        signatureType: 0,
      },
    };
    const rpcTypedData = JSON.parse(
      JSON.stringify(typedData, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );

    const signature = await provider.request({
      method: 'eth_signTypedData_v4',
      params: [wallet.account, JSON.stringify(rpcTypedData)],
    });
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature,
    });

    expect(getAddress(recovered)).toBe(wallet.account);
  });

  it('read-only mode refuses transaction broadcast without any network call', async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey).address;
    const browserFetch = vi.fn();
    const provider = installProvider({
      account,
      mode: QA_WALLET_MODES.READ_ONLY,
      fetchImpl: browserFetch,
    });

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: account, to: zeroAddress, value: '0x0' }],
      }),
    ).rejects.toMatchObject({ code: 4100, message: READ_ONLY_ERROR_MESSAGE });
    expect(browserFetch).not.toHaveBeenCalled();

    const chainNetworkCall = vi.fn();
    const wallet = loadQaWalletService(runtimeEnv(privateKey), {
      broadcastTransaction: chainNetworkCall,
    });
    await expect(
      wallet.request('eth_sendTransaction', [
        { from: account, to: zeroAddress, value: '0x0' },
      ]),
    ).rejects.toMatchObject({ code: 4100, message: READ_ONLY_ERROR_MESSAGE });
    expect(chainNetworkCall).not.toHaveBeenCalled();
  });

  it('broadcast mode delegates a normalized Arc transaction to the signer transport', async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey).address;
    const transactionHash = `0x${'ab'.repeat(32)}`;
    const chainNetworkCall = vi.fn().mockResolvedValue(transactionHash);
    const wallet = loadQaWalletService(
      runtimeEnv(privateKey, QA_WALLET_MODES.BROADCAST),
      { broadcastTransaction: chainNetworkCall },
    );
    const provider = installProvider({
      account,
      mode: wallet.mode,
      fetchImpl: signerFetch(wallet),
    });

    await expect(
      provider.request({
        method: 'eth_sendTransaction',
        params: [
          {
            from: account,
            to: zeroAddress,
            chainId: ARC_CHAIN_ID_HEX,
            value: '0x0',
          },
        ],
      }),
    ).resolves.toBe(transactionHash);
    expect(chainNetworkCall).toHaveBeenCalledOnce();
    expect(chainNetworkCall).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ address: account }),
        chain: expect.objectContaining({ id: ARC_CHAIN_ID }),
        to: zeroAddress,
        value: 0n,
      }),
    );
  });

  it('does not expose runtime key material in signer logs or browser assets', async () => {
    const privateKey = generatePrivateKey();
    const logs = [];
    const runtime = await startQaWalletServer({
      env: runtimeEnv(privateKey),
      logger: { info: (message) => logs.push(message) },
      port: 0,
      providerSource,
    });

    try {
      const [health, provider] = await Promise.all([
        fetch(`${runtime.baseUrl}/healthz`).then((response) => response.text()),
        fetch(`${runtime.baseUrl}/provider.js`).then((response) => response.text()),
      ]);
      const output = [logs.join('\n'), health, provider].join('\n');
      // Assert via a boolean so even a failing test reporter cannot echo the
      // secret as an expected substring.
      expect(output.includes(privateKey)).toBe(false);
      expect(provider).toContain('PREDEX_QA_INJECTED_PROVIDER_V1');
    } finally {
      await runtime.close();
    }
  });
});
