import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourceRoots = ['app', 'components', 'lib', 'public', 'styles']
  .map((directory) => join(process.cwd(), directory))
  .filter(existsSync);
const tokensPath = join(process.cwd(), 'styles/tokens.css');
const hardcodedColor =
  /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b|\b(?:color|hsla?|hwb|lab|lch|oklab|oklch|rgba?)\([^)]*\)/giu;

function renderedSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return renderedSourceFiles(path);
    if (
      path === tokensPath ||
      !/\.(?:css|svg|tsx?)$/u.test(entry.name) ||
      /\.(?:spec|test)\./u.test(entry.name)
    ) {
      return [];
    }
    return [path];
  });
}

function colorViolations() {
  return sourceRoots.flatMap((root) =>
    renderedSourceFiles(root).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [...source.matchAll(hardcodedColor)].map((match) => {
        const beforeMatch = source.slice(0, match.index);
        const line = beforeMatch.split('\n').length;
        return `${relative(process.cwd(), path)}:${line}:${match[0]}`;
      });
    }),
  );
}

describe('rendered source color tokens', () => {
  it('recognizes hexadecimal and functional color literals', () => {
    const samples = [
      '#abc',
      '#aabbcc',
      'rgb(255 255 255 / 84%)',
      'rgba(255, 255, 255, 0.84)',
      'hsl(10 20% 30%)',
      'oklch(60% 0.2 20)',
    ];

    expect(
      samples.every((sample) => [...sample.matchAll(hardcodedColor)].length === 1),
    ).toBe(true);
  });

  it('contains no palette literals outside the shared token set', () => {
    expect(colorViolations()).toEqual([]);
  });

  it('defines the semantic component colors in the shared token set', () => {
    const tokens = readFileSync(join(process.cwd(), 'styles/tokens.css'), 'utf8');
    for (const token of [
      '--brand-hover',
      '--yes-border',
      '--no-border',
      '--surface-muted',
      '--surface-sunken',
      '--warning-ink',
      '--warning-border',
      '--text-on-accent',
    ]) {
      expect(tokens).toContain(`${token}:`);
    }
  });
});
