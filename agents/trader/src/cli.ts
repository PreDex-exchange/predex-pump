import {
  createCircleX402PaymentProvider,
  createRestClient,
  createTruthClient,
  privateKeyAccountFromEnv,
} from '@predex-pump/agent-sdk';
import { ADDRESSES, ARC } from '@predex-pump/shared';
import { zeroAddress } from 'viem';

import { TraderAgent, runTraderLoop } from './agent.js';
import type {
  TruthSignalReadInput,
  TruthSignalReadResult,
} from './agent.js';
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
      `sessionSpendRaw=${config.maxSessionSpendRaw}] ` +
      `truthMode=${config.truthMode} truthMaxPaymentRaw=${config.truthMaxPaymentRaw} ` +
      `pollMs=${config.pollIntervalMs}`,
  });

  let readSignal: (
    input: TruthSignalReadInput,
  ) => Promise<TruthSignalReadResult>;
  if (config.truthMode === 'free') {
    readSignal = async ({ marketId }) => {
      const signal = await restClient.getTruthSignal(marketId);
      logger.write({
        level: 'info',
        event: 'signal-payment',
        marketId,
        message: 'truth read → free/direct mode → paidRaw=0',
      });
      return { signal, paymentSpendRaw: 0n };
    };
  } else if (config.truthMode === 'skip') {
    readSignal = async () => {
      throw new Error('truth reads are disabled by PREDEX_TRUTH_MODE=skip');
    };
  } else {
    const paymentProvider =
      config.truthMode === 'paid'
        ? createCircleX402PaymentProvider(
            privateKeyAccountFromEnv('PREDEX_TRUTH_PRIVATE_KEY'),
          )
        : undefined;
    const truthClient = createTruthClient({
      baseUrl: config.apiUrl,
      ...(paymentProvider === undefined ? {} : { paymentProvider }),
    });
    readSignal = async ({ marketId, maxPaymentRaw }) => {
      const paymentLimit =
        config.truthMaxPaymentRaw < maxPaymentRaw
          ? config.truthMaxPaymentRaw
          : maxPaymentRaw;
      const result = await truthClient.buy({
        marketId,
        payment: {
          asset: ADDRESSES.usdc,
          network: `eip155:${ARC.chainId}`,
          maxAmountRaw: paymentLimit,
        },
      });
      logger.write({
        level: 'info',
        event: 'signal-payment',
        marketId,
        notionalRaw: result.paymentReceipt.amountRaw.toString(),
        ...(result.paymentReceipt.transaction?.startsWith('0x') === true
          ? {
              txHash: result.paymentReceipt.transaction as `0x${string}`,
            }
          : {}),
        message: result.paymentReceipt.paid
          ? `truth read → Circle Gateway nanopayment authorized ` +
            `amountRaw=${result.paymentReceipt.amountRaw} network=${result.paymentReceipt.network ?? 'unknown'}`
          : 'truth read → unpaid dev endpoint → paidRaw=0',
      });
      return {
        signal: result.signal,
        paymentSpendRaw: result.paymentReceipt.amountRaw,
      };
    };
  }

  const agent = new TraderAgent({
    dataClient: restClient,
    readSignal,
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
