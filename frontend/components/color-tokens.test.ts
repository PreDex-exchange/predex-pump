import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const componentsRoot = join(process.cwd(), 'components');
const hardcodedHex = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b/giu;

function renderedComponentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return renderedComponentFiles(path);
    if (!/\.(?:css|tsx?)$/u.test(entry.name) || /\.test\./u.test(entry.name)) {
      return [];
    }
    return [path];
  });
}

describe('rendered component color tokens', () => {
  it('contains no inline hexadecimal palette values', () => {
    const violations = renderedComponentFiles(componentsRoot).flatMap((path) => {
      const matches = [...readFileSync(path, 'utf8').matchAll(hardcodedHex)];
      return matches.map((match) => `${path}:${match.index}:${match[0]}`);
    });

    expect(violations).toEqual([]);
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
