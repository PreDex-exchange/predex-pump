import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  BENCHMARK_SERVER_COMMAND_TIMEOUT_MS,
  BENCHMARK_SERVER_READY_TIMEOUT_MS,
  BENCHMARK_SERVER_STOP_TIMEOUT_MS,
  parseBenchmarkServerMessage,
  type BenchmarkServerMessage,
  type PublishDistribution,
} from './protocol.js';

export interface BenchmarkProcessIsolation {
  enabled: true;
  distinctProcesses: true;
  serverPid: number;
  loadGeneratorPid: number;
  restTransport: 'loopback-http';
  websocketTransport: 'loopback-ws';
  publishControlTransport: 'node-ipc';
  redisOwnedBy: 'server';
  redisConfigured: boolean;
  serverEntry: 'bench/server.ts';
  loadGeneratorEntry: 'bench/run.ts';
}

export interface BenchmarkServerController {
  baseUrl: string;
  websocketUrl: string;
  isolation: BenchmarkProcessIsolation;
  publish(eventCount: number, baseTimestamp: number): Promise<PublishDistribution>;
  close(): Promise<void>;
}

interface PendingPublish {
  resolve(result: PublishDistribution): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeout(milliseconds: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), milliseconds);
    timer.unref();
  });
}

function send(child: ChildProcess, message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error('Benchmark server IPC channel is closed'));
      return;
    }
    child.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

export async function launchBenchmarkServer(
  databaseUrl: string,
): Promise<BenchmarkServerController> {
  const child = fork(
    fileURLToPath(new URL('./server.ts', import.meta.url)),
    [],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PREDEX_BENCH_SERVER_DATABASE_URL: databaseUrl,
      },
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  const pending = new Map<string, PendingPublish>();
  let readyResolve!: (message: Extract<BenchmarkServerMessage, { type: 'ready' }>) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<Extract<BenchmarkServerMessage, { type: 'ready' }>>(
    (resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    },
  );
  let stoppedResolve!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stoppedResolve = resolve;
  });
  let exitResolve!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    exitResolve = resolve;
  });
  let closing = false;
  let readySeen = false;
  let childFailure: Error | undefined;

  const rejectPending = (error: Error): void => {
    for (const command of pending.values()) {
      clearTimeout(command.timer);
      command.reject(error);
    }
    pending.clear();
  };

  child.on('message', (value: unknown) => {
    let message: BenchmarkServerMessage;
    try {
      message = parseBenchmarkServerMessage(value);
    } catch (error) {
      const invalid = new Error(
        `Benchmark server IPC protocol error: ${errorMessage(error)}`,
      );
      childFailure = invalid;
      readyReject(invalid);
      rejectPending(invalid);
      child.kill('SIGTERM');
      return;
    }
    if (message.type === 'ready') {
      readySeen = true;
      readyResolve(message);
      return;
    }
    if (message.type === 'publish-result') {
      const command = pending.get(message.requestId);
      if (command === undefined) return;
      pending.delete(message.requestId);
      clearTimeout(command.timer);
      command.resolve(message.result);
      return;
    }
    if (message.type === 'fatal') {
      const fatal = new Error(`Benchmark server failed: ${message.message}`);
      childFailure = fatal;
      readyReject(fatal);
      rejectPending(fatal);
      return;
    }
    stoppedResolve();
  });
  child.once('error', (error) => {
    const wrapped = new Error(`Benchmark server process error: ${error.message}`);
    childFailure = wrapped;
    readyReject(wrapped);
    rejectPending(wrapped);
  });
  child.once('exit', (code, signal) => {
    exitResolve({ code, signal });
    stoppedResolve();
    if (!readySeen) {
      readyReject(
        new Error(
          `Benchmark server exited before readiness code=${String(code)} signal=${String(signal)}`,
        ),
      );
    }
    if (!closing) {
      childFailure ??= new Error(
        `Benchmark server exited unexpectedly code=${String(code)} signal=${String(signal)}`,
      );
      rejectPending(childFailure);
    } else if (code !== 0 && childFailure === undefined) {
      childFailure = new Error(
        `Benchmark server exited during cleanup code=${String(code)} signal=${String(signal)}`,
      );
    }
  });

  const terminate = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const terminated = await Promise.race([
      exited.then(() => 'exited' as const),
      timeout(2_000),
    ]);
    if (terminated === 'timeout' && child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  };

  const readinessTimer = setTimeout(() => {
    readyReject(
      new Error(
        `Benchmark server readiness timed out after ${BENCHMARK_SERVER_READY_TIMEOUT_MS}ms`,
      ),
    );
  }, BENCHMARK_SERVER_READY_TIMEOUT_MS);

  let readyMessage: Extract<BenchmarkServerMessage, { type: 'ready' }>;
  try {
    readyMessage = await ready;
  } catch (error) {
    closing = true;
    await terminate();
    throw error;
  } finally {
    clearTimeout(readinessTimer);
  }

  if (
    child.pid === undefined ||
    readyMessage.pid !== child.pid ||
    readyMessage.pid === process.pid
  ) {
    closing = true;
    await terminate();
    throw new Error('Benchmark server did not prove distinct process identity');
  }

  return {
    baseUrl: readyMessage.baseUrl,
    websocketUrl: readyMessage.websocketUrl,
    isolation: {
      enabled: true,
      distinctProcesses: true,
      serverPid: readyMessage.pid,
      loadGeneratorPid: process.pid,
      restTransport: 'loopback-http',
      websocketTransport: 'loopback-ws',
      publishControlTransport: 'node-ipc',
      redisOwnedBy: 'server',
      redisConfigured: readyMessage.redisConfigured,
      serverEntry: 'bench/server.ts',
      loadGeneratorEntry: 'bench/run.ts',
    },
    publish: async (eventCount, baseTimestamp) => {
      const requestId = randomUUID();
      const result = new Promise<PublishDistribution>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(
            new Error(
              `Benchmark publish command timed out after ${BENCHMARK_SERVER_COMMAND_TIMEOUT_MS}ms`,
            ),
          );
        }, BENCHMARK_SERVER_COMMAND_TIMEOUT_MS);
        pending.set(requestId, { resolve, reject, timer });
      });
      try {
        await send(child, {
          type: 'publish',
          requestId,
          eventCount,
          baseTimestamp,
        });
      } catch (error) {
        const command = pending.get(requestId);
        if (command !== undefined) {
          pending.delete(requestId);
          clearTimeout(command.timer);
          command.reject(
            new Error(`Benchmark publish IPC failed: ${errorMessage(error)}`),
          );
        }
      }
      return result;
    },
    close: async () => {
      if (closing) {
        await exited;
        if (childFailure !== undefined) throw childFailure;
        return;
      }
      closing = true;
      rejectPending(new Error('Benchmark server is shutting down'));
      if (child.exitCode !== null || child.signalCode !== null) {
        if (childFailure !== undefined) throw childFailure;
        return;
      }
      await send(child, { type: 'shutdown' }).catch(() => undefined);
      const graceful = await Promise.race([
        stopped.then(() => 'stopped' as const),
        timeout(BENCHMARK_SERVER_STOP_TIMEOUT_MS),
      ]);
      if (graceful === 'timeout' && child.exitCode === null) {
        await terminate();
      } else if (child.exitCode === null && child.signalCode === null) {
        const cleanExit = await Promise.race([
          exited.then(() => 'exited' as const),
          timeout(2_000),
        ]);
        if (cleanExit === 'timeout') await terminate();
      }
      if (childFailure !== undefined) throw childFailure;
    },
  };
}
