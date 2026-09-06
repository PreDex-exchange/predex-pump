import { describe, expect, it, vi } from 'vitest';

import {
  loadOperatorPrivateKey,
  type OperatorCredentialFileReader,
} from '../src/orderbook/operator.js';

const TEST_KEY = `0x${'1'.repeat(64)}` as const;

function reader(mode = 0o100600): OperatorCredentialFileReader & {
  readFile: ReturnType<typeof vi.fn<() => Promise<string>>>;
} {
  return {
    lstat: async () => ({ mode, isFile: () => true }),
    readFile: vi.fn(async () => `\n ${TEST_KEY}\r\n`),
  };
}

describe('operator credential loading', () => {
  it('reads and trims an owner-only credential file', async () => {
    const files = reader();
    await expect(
      loadOperatorPrivateKey(
        { OPERATOR_PRIVATE_KEY_FILE: '/run/credentials/predex.operator' },
        files,
      ),
    ).resolves.toBe(TEST_KEY);
    expect(files.readFile).toHaveBeenCalledWith(
      '/run/credentials/predex.operator',
    );
  });

  it('rejects ambiguous env/file configuration before reading either secret', async () => {
    const files = reader();
    await expect(
      loadOperatorPrivateKey(
        {
          OPERATOR_PRIVATE_KEY: TEST_KEY,
          OPERATOR_PRIVATE_KEY_FILE: '/run/credentials/predex.operator',
        },
        files,
      ),
    ).rejects.toThrow('mutually exclusive');
    expect(files.readFile).not.toHaveBeenCalled();
  });

  it('rejects a credential readable by group or other users', async () => {
    const files = reader(0o100640);
    await expect(
      loadOperatorPrivateKey(
        { OPERATOR_PRIVATE_KEY_FILE: '/run/credentials/predex.operator' },
        files,
      ),
    ).rejects.toThrow('inaccessible to group/other users');
    expect(files.readFile).not.toHaveBeenCalled();
  });

  it('preserves direct environment-key compatibility', async () => {
    await expect(loadOperatorPrivateKey({ OPERATOR_PRIVATE_KEY: TEST_KEY })).resolves.toBe(
      TEST_KEY,
    );
  });
});
