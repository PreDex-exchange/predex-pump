import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import {
  ARC_CHAIN_ID,
  ARC_CHAIN_ID_HEX,
  QA_PROVIDER_MARKER,
} from './constants.mjs';
import { loadQaWalletService, QaWalletRpcError } from './wallet-service.mjs';

const PROVIDER_SOURCE_URL = new URL('./injected-provider.js', import.meta.url);
const MAX_BODY_BYTES = 1_000_000;

function loopbackOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('QA_WALLET_ALLOWED_ORIGIN must be an HTTP loopback origin.');
  }
  return url.origin;
}

function configuredPort(value) {
  if (value === undefined || value === '') return 3_003;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('QA_WALLET_PORT must be an integer from 1 through 65535.');
  }
  return port;
}

function sendJson(response, status, value, corsOrigin) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(corsOrigin
      ? {
          'access-control-allow-origin': corsOrigin,
          vary: 'Origin',
        }
      : {}),
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new QaWalletRpcError(-32600, 'QA wallet RPC requires application/json.');
  }
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      throw new QaWalletRpcError(-32600, 'QA wallet RPC request is too large.');
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new QaWalletRpcError(-32700, 'QA wallet RPC request is not valid JSON.');
  }
}

function rpcError(error) {
  if (error instanceof QaWalletRpcError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  }
  return {
    code: -32603,
    message: error instanceof Error ? error.message : 'QA wallet request failed.',
  };
}

export function assertQaServerEnvironment(env = process.env) {
  if (env.NODE_ENV === 'production') {
    throw new Error('The QA wallet signer refuses to run with NODE_ENV=production.');
  }
}

export async function startQaWalletServer({
  env = process.env,
  logger = console,
  port: portOverride,
  providerSource: providerSourceOverride,
} = {}) {
  assertQaServerEnvironment(env);
  const wallet = loadQaWalletService(env);
  // The account closure now owns the signing capability; remove the original
  // text value from this process environment before any server work or logging.
  if (env === process.env) delete process.env.QA_WALLET_PRIVATE_KEY;
  const allowedOrigin = loopbackOrigin(
    env.QA_WALLET_ALLOWED_ORIGIN ?? 'http://127.0.0.1:3002',
  );
  const providerSource =
    providerSourceOverride ?? (await readFile(PROVIDER_SOURCE_URL, 'utf8'));
  if (!providerSource.includes(QA_PROVIDER_MARKER)) {
    throw new Error('QA provider source marker is missing.');
  }
  const token = randomBytes(24).toString('base64url');
  const host = '127.0.0.1';
  const port = portOverride ?? configuredPort(env.QA_WALLET_PORT);

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${host}`);
    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      sendJson(response, 200, {
        ok: true,
        account: wallet.account,
        chainId: ARC_CHAIN_ID,
        mode: wallet.mode,
      });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/provider.js') {
      const bootstrap = JSON.stringify({
        account: wallet.account,
        chainId: ARC_CHAIN_ID,
        chainIdHex: ARC_CHAIN_ID_HEX,
        mode: wallet.mode,
        rpcUrl: `http://${host}:${server.address().port}/rpc`,
        token,
      }).replaceAll('<', '\\u003c');
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': allowedOrigin,
        vary: 'Origin',
        'x-content-type-options': 'nosniff',
      });
      response.end(
        `globalThis.__PREDEX_QA_WALLET_CONFIG__=${bootstrap};\n${providerSource}`,
      );
      return;
    }

    if (request.method === 'OPTIONS' && requestUrl.pathname === '/rpc') {
      if (request.headers.origin !== allowedOrigin) {
        response.writeHead(403, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      response.writeHead(204, {
        'access-control-allow-origin': allowedOrigin,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type,x-predex-qa-token',
        'access-control-max-age': '600',
        vary: 'Origin',
      });
      response.end();
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/rpc') {
      if (
        request.headers.origin !== allowedOrigin ||
        request.headers['x-predex-qa-token'] !== token
      ) {
        sendJson(response, 403, {
          error: { code: 4100, message: 'QA wallet request was not authorized.' },
        });
        return;
      }
      try {
        const body = await readJsonBody(request);
        if (
          typeof body !== 'object' ||
          body === null ||
          Array.isArray(body) ||
          typeof body.method !== 'string' ||
          (body.params !== undefined && !Array.isArray(body.params))
        ) {
          throw new QaWalletRpcError(-32600, 'QA wallet RPC request is invalid.');
        }
        const result = await wallet.request(body.method, body.params ?? []);
        sendJson(response, 200, { result }, allowedOrigin);
      } catch (error) {
        const serialized = rpcError(error);
        sendJson(
          response,
          serialized.code === 4100 ? 403 : 400,
          { error: serialized },
          allowedOrigin,
        );
      }
      return;
    }

    sendJson(response, 404, { error: { code: -32601, message: 'Not found.' } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('QA wallet signer did not bind a TCP address.');
  }
  const baseUrl = `http://${host}:${address.port}`;
  logger.info(
    `[qa-wallet] ${baseUrl} account=${wallet.account} chainId=${ARC_CHAIN_ID} mode=${wallet.mode}`,
  );

  return {
    account: wallet.account,
    baseUrl,
    mode: wallet.mode,
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function main() {
  const runtime = await startQaWalletServer();
  const close = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown startup failure.';
    console.error(`[qa-wallet] startup failed: ${message}`);
    process.exitCode = 1;
  });
}
