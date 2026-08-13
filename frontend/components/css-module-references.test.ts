import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.[jt]sx?$/u.test(entry.name)) return [];
    if (/\.(?:test|spec)\.[jt]sx?$/u.test(entry.name)) return [];
    return [path];
  });
}

function escapedRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

describe('CSS module references', () => {
  it('backs every literal component reference with a local class declaration', () => {
    const root = process.cwd();
    const files = [
      ...sourceFiles(join(root, 'app')),
      ...sourceFiles(join(root, 'components')),
    ];
    const missing: string[] = [];

    for (const sourcePath of files) {
      const source = readFileSync(sourcePath, 'utf8');
      const imports = source.matchAll(
        /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"](\.{1,2}\/[^'"]+\.module\.css)['"]/gu,
      );

      for (const match of imports) {
        const [, binding, importPath] = match;
        if (!binding || !importPath) continue;
        const stylesheetPath = resolve(dirname(sourcePath), importPath);
        const stylesheet = readFileSync(stylesheetPath, 'utf8');
        const declarations = new Set(
          [...stylesheet.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/gu)].map(
            (declaration) => declaration[1],
          ),
        );
        const bindingPattern = escapedRegExp(binding);
        const references = [
          ...source.matchAll(
            new RegExp(
              `\\b${bindingPattern}\\.([A-Za-z_][A-Za-z0-9_]*)`,
              'gu',
            ),
          ),
          ...source.matchAll(
            new RegExp(
              `\\b${bindingPattern}\\[['"]([A-Za-z_][A-Za-z0-9_-]*)['"]\\]`,
              'gu',
            ),
          ),
        ];

        for (const reference of references) {
          const className = reference[1];
          if (className && !declarations.has(className)) {
            missing.push(
              `${relative(root, sourcePath)} references ${relative(
                root,
                stylesheetPath,
              )}#${className}`,
            );
          }
        }
      }
    }

    expect(missing.sort()).toEqual([]);
  });
});
