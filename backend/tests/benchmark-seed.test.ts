import { ADDRESSES } from '@predex-pump/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { seedBenchmarkSingletons } from '../bench/seed.js';
import { buildServer } from '../src/api/server.js';
import { ServerEventBus } from '../src/events/bus.js';
import { resetDatabase, testPrisma } from './database.js';

describe('benchmark seed', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('seeds chain configuration that the public config endpoint can serve', async () => {
    await seedBenchmarkSingletons(testPrisma);
    const app = await buildServer({
      prisma: testPrisma,
      eventBus: new ServerEventBus(),
      logger: false,
    });

    try {
      const response = await app.inject({ method: 'GET', url: '/config' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        marketTypeVersion: 2,
        addresses: { lmsr: ADDRESSES.lmsr.toLowerCase() },
      });
    } finally {
      await app.close();
    }
  });
});
