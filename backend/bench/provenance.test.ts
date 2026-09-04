import { describe, expect, it, vi } from 'vitest';

import { resolveBenchmarkProvenance } from './provenance.js';

describe('benchmark source provenance', () => {
  it('uses Git metadata when it is available', () => {
    const readSourceMarker = vi.fn(() => 'unused');
    const provenance = resolveBenchmarkProvenance({
      readGit: (args) =>
        args[0] === 'rev-parse'
          ? '0123456789abcdef0123456789abcdef01234567\n'
          : 'fix/benchmark-chain-config\n',
      readSourceMarker,
    });

    expect(provenance).toEqual({
      kind: 'git',
      sourceId: '0123456789abcdef0123456789abcdef01234567',
      commit: '0123456789abcdef0123456789abcdef01234567',
      branch: 'fix/benchmark-chain-config',
    });
    expect(readSourceMarker).not.toHaveBeenCalled();
  });

  it('falls back to the validated CloudLab source marker without Git', () => {
    const provenance = resolveBenchmarkProvenance({
      readGit: () => {
        throw new Error('not a Git checkout');
      },
      readSourceMarker: () => '4c4808701845-900ece8ea5a5\n',
    });

    expect(provenance).toEqual({
      kind: 'source-marker',
      sourceId: '4c4808701845-900ece8ea5a5',
      commit: '4c4808701845',
      branch: null,
    });
  });

  it('rejects an invalid fallback marker', () => {
    expect(() =>
      resolveBenchmarkProvenance({
        readGit: () => {
          throw new Error('not a Git checkout');
        },
        readSourceMarker: () => 'unbound-source',
      }),
    ).toThrow('Invalid .predex-source-id');
  });
});
