import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface BenchmarkProvenance {
  kind: 'git' | 'source-marker';
  sourceId: string;
  commit: string;
  branch: string | null;
}

interface ProvenanceReaders {
  readGit(args: readonly string[]): string;
  readSourceMarker(): string;
}

const defaultReaders: ProvenanceReaders = {
  readGit: (args) =>
    execFileSync('git', [...args], {
      cwd: resolve('..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  readSourceMarker: () =>
    readFileSync(resolve('..', '.predex-source-id'), 'utf8'),
};

const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const SOURCE_MARKER = /^([0-9a-f]{12})-[0-9a-f]{12}$/u;

export function resolveBenchmarkProvenance(
  readers: ProvenanceReaders = defaultReaders,
): BenchmarkProvenance {
  try {
    const commit = readers.readGit(['rev-parse', 'HEAD']).trim();
    if (!GIT_COMMIT.test(commit)) throw new Error('Invalid Git commit');
    const branch = readers.readGit(['branch', '--show-current']).trim();
    return {
      kind: 'git',
      sourceId: commit,
      commit,
      branch: branch || null,
    };
  } catch {
    const sourceId = readers.readSourceMarker().trim();
    const match = SOURCE_MARKER.exec(sourceId);
    if (match?.[1] === undefined) {
      throw new Error('Invalid .predex-source-id');
    }
    return {
      kind: 'source-marker',
      sourceId,
      commit: match[1],
      branch: null,
    };
  }
}
