import { PrismaClient } from '@prisma/client';

import { loadRuntimeConfig } from './config.js';

const config = loadRuntimeConfig();

export const prisma = new PrismaClient({
  datasourceUrl: config.databaseUrl,
});
