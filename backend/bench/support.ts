import { spawnSync } from 'node:child_process';

import { PrismaClient } from '@prisma/client';

export const DEFAULT_BENCH_DATABASE_URL =
  'postgresql://predex:predex@localhost:5432/predex_pump?schema=perf_bench';

const SAFE_SCHEMA = /^perf_bench(?:_[a-z0-9_]+)?$/;

export interface Scale {
  markets: number;
  accounts: number;
  trades: number;
  positions: number;
  orders: number;
  fills: number;
  pricePoints: number;
  activityEvents: number;
}

export const DEFAULT_SCALE: Readonly<Scale> = {
  markets: 2_000,
  accounts: 20_000,
  trades: 200_000,
  positions: 100_000,
  orders: 50_000,
  fills: 25_000,
  pricePoints: 200_000,
  activityEvents: 1_000_000,
};

export function readFlag(
  argv: readonly string[],
  name: string,
): string | undefined {
  const equals = argv.find((argument) => argument.startsWith(`--${name}=`));
  if (equals !== undefined) return equals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export function positiveFlag(
  argv: readonly string[],
  name: string,
  fallback: number,
): number {
  const raw = readFlag(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer, received ${raw}`);
  }
  return value;
}

export function nonNegativeFlag(
  argv: readonly string[],
  name: string,
  fallback: number,
): number {
  const raw = readFlag(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer, received ${raw}`);
  }
  return value;
}

export function benchDatabaseUrl(argv: readonly string[] = process.argv.slice(2)): string {
  const value =
    readFlag(argv, 'database-url') ??
    process.env.BENCH_DATABASE_URL ??
    DEFAULT_BENCH_DATABASE_URL;
  assertSafeBenchDatabase(value);
  return value;
}

export function benchSchema(databaseUrl: string): string {
  const schema = new URL(databaseUrl).searchParams.get('schema');
  if (schema === null || !SAFE_SCHEMA.test(schema)) {
    throw new Error(
      `Benchmark database URL must select a schema named perf_bench or perf_bench_*, received ${String(
        schema,
      )}`,
    );
  }
  return schema;
}

export function assertSafeBenchDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('Benchmark database URL must use PostgreSQL');
  }
  benchSchema(databaseUrl);
}

export function makePrisma(databaseUrl: string): PrismaClient {
  assertSafeBenchDatabase(databaseUrl);
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

export async function dropBenchSchema(databaseUrl: string): Promise<void> {
  const schema = benchSchema(databaseUrl);
  const prisma = makePrisma(databaseUrl);
  try {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await prisma.$disconnect();
  }
}

export async function resetBenchSchema(databaseUrl: string): Promise<void> {
  await dropBenchSchema(databaseUrl);
  const result = spawnSync(
    'pnpm',
    ['exec', 'prisma', 'db', 'push', '--skip-generate'],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Prisma schema preparation failed with status ${String(result.status)}`);
  }
}

export function address(index: number): string {
  return `0x${BigInt(index + 1).toString(16).padStart(40, '0')}`;
}

export function hash(index: number | bigint): string {
  return `0x${BigInt(index).toString(16).padStart(64, '0')}`;
}

export async function inBatches<T>(
  rows: readonly T[],
  size: number,
  insert: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += size) {
    await insert(rows.slice(offset, offset + size));
  }
}

export async function generatedBatches<T>(
  count: number,
  size: number,
  generate: (index: number) => T,
  insert: (batch: T[]) => Promise<unknown>,
  progressLabel: string,
): Promise<void> {
  const startedAt = performance.now();
  for (let offset = 0; offset < count; offset += size) {
    const end = Math.min(count, offset + size);
    const rows: T[] = [];
    for (let index = offset; index < end; index += 1) {
      rows.push(generate(index));
    }
    await insert(rows);
    if (end === count || end % Math.max(size, 50_000) === 0) {
      const seconds = (performance.now() - startedAt) / 1_000;
      console.info(
        `[seed] ${progressLabel} ${end.toLocaleString()}/${count.toLocaleString()} ` +
          `(${Math.round(end / Math.max(seconds, 0.001)).toLocaleString()} rows/s)`,
      );
    }
  }
}

export function scaleFromArgs(argv: readonly string[]): Scale {
  const scale = {
    markets: positiveFlag(argv, 'markets', DEFAULT_SCALE.markets),
    accounts: positiveFlag(argv, 'accounts', DEFAULT_SCALE.accounts),
    trades: nonNegativeFlag(argv, 'trades', DEFAULT_SCALE.trades),
    positions: nonNegativeFlag(argv, 'positions', DEFAULT_SCALE.positions),
    orders: nonNegativeFlag(argv, 'orders', DEFAULT_SCALE.orders),
    fills: nonNegativeFlag(argv, 'fills', DEFAULT_SCALE.fills),
    pricePoints: nonNegativeFlag(
      argv,
      'price-points',
      DEFAULT_SCALE.pricePoints,
    ),
    activityEvents: nonNegativeFlag(
      argv,
      'activity-events',
      DEFAULT_SCALE.activityEvents,
    ),
  };
  if (scale.fills > 0 && scale.orders === 0) {
    throw new Error('--fills requires at least one order');
  }
  if (scale.positions > scale.accounts * scale.markets * 2) {
    throw new Error(
      `Requested ${scale.positions} positions exceeds the unique schema capacity`,
    );
  }
  return scale;
}
