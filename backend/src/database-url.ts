export interface DatabasePoolOptions {
  connectionLimit: number;
  poolTimeoutSeconds: number;
}

export const DEFAULT_DATABASE_POOL_OPTIONS: Readonly<DatabasePoolOptions> = {
  connectionLimit: 32,
  poolTimeoutSeconds: 10,
};

export function withDatabasePool(
  databaseUrl: string,
  options: DatabasePoolOptions = DEFAULT_DATABASE_POOL_OPTIONS,
): string {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use PostgreSQL');
  }
  if (!parsed.searchParams.has('connection_limit')) {
    parsed.searchParams.set('connection_limit', String(options.connectionLimit));
  }
  if (!parsed.searchParams.has('pool_timeout')) {
    parsed.searchParams.set('pool_timeout', String(options.poolTimeoutSeconds));
  }
  return parsed.toString();
}
