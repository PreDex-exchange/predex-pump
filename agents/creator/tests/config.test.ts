import { describe, expect, it } from 'vitest';

import { loadCreatorConfig } from '../src/config.js';

describe('loadCreatorConfig', () => {
  it('defaults to dry-run without requiring a private key', () => {
    const config = loadCreatorConfig({}, []);

    expect(config.dryRun).toBe(true);
    expect(config.privateKey).toBeUndefined();
    expect(config.seedAmountRaw).toBe(1_000_000n);
  });

  it('requires a runtime key for an explicit send opt-in', () => {
    expect(() => loadCreatorConfig({}, ['--send'])).toThrow(
      /PREDEX_PRIVATE_KEY/u,
    );
  });

  it('supports an environment-only send opt-in', () => {
    const privateKey = `0x${'12'.repeat(32)}`;
    const config = loadCreatorConfig(
      {
        PREDEX_DRY_RUN: 'false',
        PREDEX_PRIVATE_KEY: privateKey,
      },
      [],
    );

    expect(config.dryRun).toBe(false);
    expect(config.privateKey).toBe(privateKey);
  });
});
