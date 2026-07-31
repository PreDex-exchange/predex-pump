import { describe, expect, it, vi } from 'vitest';

import { terminateOnFatal } from '../src/fatal.js';

describe('fatal server shutdown', () => {
  it('logs the fatal error and exits with failure after cleanup reaches the handler', () => {
    const error = new Error('database unavailable');
    const log = vi.fn();
    const exit = vi.fn();

    terminateOnFatal(error, { exit, log });

    expect(log).toHaveBeenCalledWith('[server] fatal', error);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
