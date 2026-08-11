import { DEFAULT_INDEXER_MAX_BACKFILL_BLOCKS } from '../config.js';
import type { IndexerOptions } from './runner.js';

export const INDEXER_START_POLICY_HELP = `Startup policy:
  INDEXER_START_POLICY=auto|head|resume
      auto (default) resumes normally and starts at head only when the gap is
      greater than INDEXER_MAX_BACKFILL_BLOCKS (default ${DEFAULT_INDEXER_MAX_BACKFILL_BLOCKS.toLocaleString('en-US')}).
      head forces a cursor advance through head - 1 and records the skipped
      range before indexing the current head. resume always backfills.
  --start-at-head
      Override INDEXER_START_POLICY for this invocation and force head mode.
  --resume
      Override INDEXER_START_POLICY for this invocation and force resume mode.`;

export const INDEXER_HELP = `Usage: pnpm run indexer -- [options]

Options:
  --once                 Exit after reaching the startup head.
  --replay-from <block>  Replay an indexed range without rewinding the cursor.
  --start-at-head        Force the audited start-at-head policy now.
  --resume               Resume from the cursor regardless of gap size.
  --help                  Show this help.

${INDEXER_START_POLICY_HELP}`;

export const SERVER_HELP = `Usage: pnpm run start -- [options]

Options:
  --start-at-head  Force the audited start-at-head policy now.
  --resume         Resume from the cursor regardless of gap size.
  --help           Show this help without starting the server.

${INDEXER_START_POLICY_HELP}`;

interface StartPolicyArguments {
  help: boolean;
  startPolicy?: 'head' | 'resume';
}

function setStartPolicy(
  current: 'head' | 'resume' | undefined,
  requested: 'head' | 'resume',
): 'head' | 'resume' {
  if (current !== undefined && current !== requested) {
    throw new Error('--start-at-head and --resume are mutually exclusive');
  }
  return requested;
}

export function parseServerOptions(
  argv: readonly string[],
): StartPolicyArguments {
  let help = false;
  let startPolicy: 'head' | 'resume' | undefined;
  for (const argument of argv) {
    if (argument === '--') {
      continue;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--start-at-head') {
      startPolicy = setStartPolicy(startPolicy, 'head');
    } else if (argument === '--resume') {
      startPolicy = setStartPolicy(startPolicy, 'resume');
    } else {
      throw new Error(`Unknown server option ${argument}`);
    }
  }
  return startPolicy === undefined ? { help } : { help, startPolicy };
}

export function parseIndexerOptions(
  argv: readonly string[],
): { help: boolean; options: IndexerOptions } {
  let help = false;
  let once = false;
  let replayFrom: number | undefined;
  let startPolicy: 'head' | 'resume' | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--once') {
      once = true;
      continue;
    }
    if (argument === '--start-at-head') {
      startPolicy = setStartPolicy(startPolicy, 'head');
      continue;
    }
    if (argument === '--resume') {
      startPolicy = setStartPolicy(startPolicy, 'resume');
      continue;
    }
    if (argument?.startsWith('--replay-from=')) {
      replayFrom = Number(argument.slice('--replay-from='.length));
      continue;
    }
    if (argument === '--replay-from') {
      replayFrom = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown indexer option ${argument}`);
  }

  if (
    replayFrom !== undefined &&
    (!Number.isSafeInteger(replayFrom) || replayFrom < 0)
  ) {
    throw new Error(`Invalid --replay-from value ${String(replayFrom)}`);
  }
  if (replayFrom !== undefined && startPolicy !== undefined) {
    throw new Error(
      '--replay-from cannot be combined with --start-at-head or --resume',
    );
  }

  const options: IndexerOptions = { once };
  if (replayFrom !== undefined) options.replayFrom = replayFrom;
  if (startPolicy !== undefined) options.startPolicy = startPolicy;
  return { help, options };
}
