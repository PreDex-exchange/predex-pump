import {
  createRestClient,
  privateKeyAccountFromEnv,
} from '@predex-pump/agent-sdk';
import { zeroAddress } from 'viem';

import { TraderAgent, runTraderLoop } from './agent.js';
import { createArcTraderExecutor } from './arc-executor.js';
import { loadTraderConfig } from './config.js';
import { ConsoleTraderLogger } from './logger.js';

function printHelp(): void {
  console.info(
    [
      'Predex trader agent',
      '',
      'Dry-run is the default. Pass --send or set PREDEX_DRY_RUN=false to broadcast.',
      'Pass --once to process one complete market scan and exit.',
      'The private key is read from PREDEX_PRIVATE_KEY only after send mode is selected.',
      'All quote sizes, thresholds, hard caps, polling, API, RPC, and address settings come from env.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes('--help')) {
    printHelp();
    return;
  }

  const config = loadTraderConfig(process.env, arguments_);
  const logger = new ConsoleTraderLogger();
  let traderAddress = config.traderAddress ?? zeroAddress;
  let executor;
  if (!config.dryRun) {
    // This is the only trader-agent path that reads PREDEX_PRIVATE_KEY.
    const account = privateKeyAccountFromEnv('PREDEX_PRIVATE_KEY');
    if (
      config.traderAddress !== undefined &&
      config.traderAddress.toLowerCase() !== account.address.toLowerCase()
    ) {
      throw new Error(
        'PREDEX_TRADER_ADDRESS does not match the runtime signing key address.',
      );
    }
    traderAddress = account.address;
    executor = createArcTraderExecutor(account, config.rpcUrl);
  }

  const restClient = createRestClient({ baseUrl: config.apiUrl });
  logger.write({
    level: 'info',
    event: 'startup',
    message:
      `mode=${config.dryRun ? 'dry-run' : 'send'} api=${config.apiUrl} ` +
      `rpc=${config.rpcUrl} trader=${traderAddress} ` +
      `quoteSizeRaw=${config.quoteSizeRaw} takeSizeRaw=${config.takeSizeRaw} ` +
      `spreadRaw=${config.quoteHalfSpreadRaw} takeThresholdRaw=${config.takeThresholdRaw} ` +
      `caps[inventoryPerSideRaw=${config.maxInventoryPerSideRaw},` +
      `notionalPerOrderRaw=${config.maxNotionalPerOrderRaw},` +
      `ordersInFlight=${config.maxOrdersInFlight},` +
      `sessionSpendRaw=${config.maxSessionSpendRaw}] pollMs=${config.pollIntervalMs}`,
  });

  const agent = new TraderAgent({
    dataClient: restClient,
    readSignal: (marketId) => restClient.getTruthSignal(marketId),
    ...(executor === undefined ? {} : { executor }),
    logger,
    traderAddress,
    quoteSizeRaw: config.quoteSizeRaw,
    takeSizeRaw: config.takeSizeRaw,
    quoteHalfSpreadRaw: config.quoteHalfSpreadRaw,
    takeThresholdRaw: config.takeThresholdRaw,
    repriceThresholdRaw: config.repriceThresholdRaw,
    staleQuoteSeconds: config.staleQuoteSeconds,
    maxInventoryPerSideRaw: config.maxInventoryPerSideRaw,
    maxNotionalPerOrderRaw: config.maxNotionalPerOrderRaw,
    maxOrdersInFlight: config.maxOrdersInFlight,
    maxSessionSpendRaw: config.maxSessionSpendRaw,
    dryRun: config.dryRun,
  });
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runTraderLoop(agent, {
      pollIntervalMs: config.pollIntervalMs,
      signal: abortController.signal,
      ...(arguments_.includes('--once') ? { maxCycles: 1 } : {}),
      logger,
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    logger.write({
      level: 'info',
      event: 'stopped',
      message: 'loop → stopped',
    });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[trader] fatal configuration error: ${message}`);
  process.exitCode = 1;
});
