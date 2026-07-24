import { spawnSync } from 'node:child_process';

import { TEST_DATABASE_URL } from './test-database-url.js';

const result = spawnSync(
  'pnpm',
  ['exec', 'prisma', 'db', 'push', '--skip-generate'],
  {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  },
);

if (result.error !== undefined) throw result.error;
if (result.status !== 0) {
  throw new Error(`Test database preparation failed with status ${String(result.status)}`);
}
