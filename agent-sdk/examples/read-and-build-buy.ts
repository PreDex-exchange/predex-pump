import {
  buildBuyTx,
  createRestClient,
  createWriteClient,
  deadlineFromTimestamp,
  privateKeyAccountFromEnv,
} from '../src/index.js';

const apiUrl = process.env.PREDEX_API_URL;
const rest = createRestClient(apiUrl ? { baseUrl: apiUrl } : {});
const markets = await rest.listMarkets({ limit: 1 });
const market = markets.items[0];

if (!market) {
  throw new Error('The backend returned no markets to use in the example.');
}

const amountRaw = 1_000_000n;
const transaction = buildBuyTx({
  marketId: BigInt(market.id),
  outcome: 'YES',
  amountRaw,
  // The example proves wiring, not quote execution. A production agent must obtain
  // a fresh LMSR quote and apply the shared upper-slippage helper before sending.
  maxCostRaw: 2_000_000n,
  deadline: deadlineFromTimestamp(BigInt(Math.floor(Date.now() / 1_000))),
});

console.log({
  marketId: market.id,
  question: market.question,
  transaction: {
    ...transaction,
    value: transaction.value.toString(),
  },
});

if (process.argv.includes('--send')) {
  const account = privateKeyAccountFromEnv('PREDEX_PRIVATE_KEY');
  const writer = createWriteClient({
    account,
    ...(process.env.PREDEX_RPC_URL
      ? { rpcUrl: process.env.PREDEX_RPC_URL }
      : {}),
  });
  const hash = await writer.send(transaction);
  console.log({ hash });
}
