import { PrismaClient } from '@prisma/client';

import { loadRuntimeConfig } from './config.js';
import { withDatabasePool, type DatabasePoolOptions } from './database-url.js';

const config = loadRuntimeConfig();

export function createPrismaClient(
  databaseUrl: string,
  poolOptions: DatabasePoolOptions,
): PrismaClient {
  return new PrismaClient({
    datasourceUrl: withDatabasePool(databaseUrl, poolOptions),
  });
}

export const prisma = createPrismaClient(config.databaseUrl, {
  connectionLimit: config.databasePoolSize,
  poolTimeoutSeconds: config.databasePoolTimeoutSeconds,
});
