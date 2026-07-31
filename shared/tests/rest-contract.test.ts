import { describe, expect, it } from 'vitest';

import { routes, type TruthSignalResponse } from '../src/rest.js';

describe('truth REST contract', () => {
  it('uses the canonical paid-signal path and exports its DTO', () => {
    expect(routes.truth('42')).toBe('/truth/42');

    const response = null as TruthSignalResponse | null;
    expect(response).toBeNull();
  });
});
