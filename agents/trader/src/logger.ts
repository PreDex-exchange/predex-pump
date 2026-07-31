export type TraderLogLevel = 'info' | 'warn' | 'error';

export interface TraderLogEntry {
  level: TraderLogLevel;
  event:
    | 'startup'
    | 'market-read'
    | 'decision'
    | 'refused'
    | 'dry-run'
    | 'broadcast'
    | 'action-error'
    | 'backend-error'
    | 'signal-error'
    | 'loop-error'
    | 'stopped';
  message: string;
  marketId?: string;
  action?: 'PLACE' | 'FILL' | 'CANCEL' | 'HOLD';
  side?: 'BID' | 'ASK';
  outcome?: 'YES' | 'NO';
  orderId?: string;
  reason?: string;
  fairValueYesRaw?: string;
  priceRaw?: string;
  sizeRaw?: string;
  notionalRaw?: string;
  sessionSpendRaw?: string;
  txHash?: `0x${string}`;
}

export interface TraderLogger {
  write(entry: TraderLogEntry): void;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

export function formatTraderLogEntry(
  entry: TraderLogEntry,
  timestamp = new Date(),
): string {
  const fields = [
    timestamp.toISOString(),
    `level=${entry.level.toUpperCase()}`,
    `event=${entry.event}`,
  ];
  const labels: readonly [keyof TraderLogEntry, string][] = [
    ['marketId', 'market'],
    ['action', 'action'],
    ['outcome', 'outcome'],
    ['side', 'side'],
    ['orderId', 'order'],
    ['fairValueYesRaw', 'fairYesRaw'],
    ['priceRaw', 'priceRaw'],
    ['sizeRaw', 'sizeRaw'],
    ['notionalRaw', 'notionalRaw'],
    ['sessionSpendRaw', 'sessionSpendRaw'],
    ['reason', 'reason'],
    ['txHash', 'tx'],
  ];
  for (const [key, label] of labels) {
    const value = entry[key];
    if (typeof value === 'string') fields.push(`${label}=${quoted(value)}`);
  }
  fields.push(entry.message);
  return fields.join(' ');
}

export class ConsoleTraderLogger implements TraderLogger {
  write(entry: TraderLogEntry): void {
    const line = formatTraderLogEntry(entry);
    if (entry.level === 'error') console.error(line);
    else if (entry.level === 'warn') console.warn(line);
    else console.info(line);
  }
}
