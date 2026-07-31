export interface FatalHandlerDependencies {
  exit?: (code: number) => void;
  log?: (message: string, error: unknown) => void;
}

export function terminateOnFatal(
  error: unknown,
  dependencies: FatalHandlerDependencies = {},
): void {
  const log = dependencies.log ?? console.error;
  const exit = dependencies.exit ?? ((code: number) => process.exit(code));
  log('[server] fatal', error);
  exit(1);
}
