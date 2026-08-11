import { describe, expect, it } from 'vitest';

import {
  INDEXER_HELP,
  parseIndexerOptions,
  parseServerOptions,
  SERVER_HELP,
} from '../src/indexer/cli.js';

describe('indexer operator overrides', () => {
  it('forces start-at-head or resume from both backend entrypoints', () => {
    expect(parseIndexerOptions(['--', '--once', '--start-at-head'])).toEqual({
      help: false,
      options: { once: true, startPolicy: 'head' },
    });
    expect(parseIndexerOptions(['--resume'])).toEqual({
      help: false,
      options: { once: false, startPolicy: 'resume' },
    });
    expect(parseServerOptions(['--', '--start-at-head'])).toEqual({
      help: false,
      startPolicy: 'head',
    });
    expect(parseServerOptions(['--resume'])).toEqual({
      help: false,
      startPolicy: 'resume',
    });
  });

  it('rejects conflicting or ambiguous cursor instructions', () => {
    expect(() =>
      parseIndexerOptions(['--start-at-head', '--resume']),
    ).toThrow('--start-at-head and --resume are mutually exclusive');
    expect(() =>
      parseIndexerOptions(['--replay-from=100', '--start-at-head']),
    ).toThrow(
      '--replay-from cannot be combined with --start-at-head or --resume',
    );
  });

  it('documents policy semantics, the threshold, and both overrides in help', () => {
    for (const help of [INDEXER_HELP, SERVER_HELP]) {
      expect(help).toContain('INDEXER_START_POLICY=auto|head|resume');
      expect(help).toContain('INDEXER_MAX_BACKFILL_BLOCKS');
      expect(help).toContain('100,000');
      expect(help).toContain('--start-at-head');
      expect(help).toContain('--resume');
      expect(help).toContain('records the skipped');
    }
  });
});
