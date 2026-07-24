import { defineConfig } from 'vitest/config';

import { TEST_DATABASE_URL } from './tests/test-database-url.js';

process.env.DATABASE_URL = TEST_DATABASE_URL;

export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
  },
});
