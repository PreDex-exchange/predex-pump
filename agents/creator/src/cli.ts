import {
  createRestClient,
  dedupCheck,
  privateKeyAccountFromEnv,
} from '@predex-pump/agent-sdk';

import { CreatorAgent, runCreatorLoop } from './agent.js';
import { createArcMarketCreator } from './arc-market-creator.js';
import { loadCreatorConfig } from './config.js';
import { ConsoleCreatorLogger } from './logger.js';
import {
  DEMO_CANDIDATES,
  StaticCandidateSource,
} from './source.js';

function printHelp(): void {
  console.info(
    [
      'Predex creator agent',
      '',
      'Dry-run is the default. Set PREDEX_DRY_RUN=false or pass --send to broadcast.',
      'Pass --once to process one source poll and exit (useful for demos).',
      'All seed, trading-window, polling, API URL, and key configuration comes from env.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes('--help')) {
    printHelp();
    return;
  }

  const config = loadCreatorConfig();
  const logger = new ConsoleCreatorLogger();
  const restClient = createRestClient({ baseUrl: config.apiUrl });
  const marketCreator = config.dryRun
    ? undefined
    : createArcMarketCreator(
        privateKeyAccountFromEnv('PREDEX_PRIVATE_KEY'),
      );
  logger.write({
    level: 'info',
    event: 'startup',
    message:
      `mode=${config.dryRun ? 'dry-run' : 'send'} api=${config.apiUrl} ` +
      `seedRaw=${config.seedAmountRaw} ` +
      `windowSeconds=${config.tradingWindowSeconds} ` +
      `pollMs=${config.pollIntervalMs}`,
  });

  const agent = new CreatorAgent({
    source: new StaticCandidateSource(DEMO_CANDIDATES),
    dedupCheck: (question) => dedupCheck(question, restClient),
    ...(marketCreator === undefined ? {} : { marketCreator }),
    logger,
    seedAmountRaw: config.seedAmountRaw,
    tradingWindowSeconds: config.tradingWindowSeconds,
    dryRun: config.dryRun,
  });
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const runOnce = process.argv.slice(2).includes('--once');
    await runCreatorLoop(agent, {
      pollIntervalMs: config.pollIntervalMs,
      signal: abortController.signal,
      ...(runOnce ? { maxCycles: 1 } : {}),
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
  console.error(`[creator] fatal configuration error: ${message}`);
  process.exitCode = 1;
});
