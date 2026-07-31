export type CreatorLogLevel = 'info' | 'warn' | 'error';

export interface CreatorLogEntry {
  level: CreatorLogLevel;
  event:
    | 'startup'
    | 'considered'
    | 'duplicate'
    | 'dedup-unavailable'
    | 'dry-run'
    | 'created'
    | 'create-error'
    | 'source-error'
    | 'loop-error'
    | 'stopped';
  message: string;
  question?: string;
  canonicalMarketId?: string;
  marketId?: string;
  txHash?: string;
}

export interface CreatorLogger {
  write(entry: CreatorLogEntry): void;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

export function formatLogEntry(
  entry: CreatorLogEntry,
  timestamp = new Date(),
): string {
  const fields = [
    timestamp.toISOString(),
    `level=${entry.level.toUpperCase()}`,
    `event=${entry.event}`,
  ];
  if (entry.question !== undefined) {
    fields.push(`question=${quoted(entry.question)}`);
  }
  if (entry.canonicalMarketId !== undefined) {
    fields.push(`canonicalMarketId=${quoted(entry.canonicalMarketId)}`);
  }
  if (entry.marketId !== undefined) {
    fields.push(`marketId=${quoted(entry.marketId)}`);
  }
  if (entry.txHash !== undefined) {
    fields.push(`tx=${quoted(entry.txHash)}`);
  }
  fields.push(entry.message);
  return fields.join(' ');
}

export class ConsoleCreatorLogger implements CreatorLogger {
  write(entry: CreatorLogEntry): void {
    const line = formatLogEntry(entry);
    if (entry.level === 'error') {
      console.error(line);
    } else if (entry.level === 'warn') {
      console.warn(line);
    } else {
      console.info(line);
    }
  }
}
