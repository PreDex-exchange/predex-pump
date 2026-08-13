import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

function componentSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return componentSources(entryPath);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [entryPath] : [];
  });
}

const localPositionValue =
  /(?:BigInt\([^)]*(?:qtyRaw|quantityRaw)[^)]*\)\s*\*\s*BigInt\([^)]*priceRaw[^)]*\)|BigInt\([^)]*priceRaw[^)]*\)\s*\*\s*BigInt\([^)]*(?:qtyRaw|quantityRaw)[^)]*\))[\s\S]{0,40}\/\s*(?:1_000_000n|RAW_SCALE|PRICE_SCALE)/u;

describe('position value ownership', () => {
  it('keeps raw position-value arithmetic out of components', () => {
    const root = process.cwd();
    const offenders = componentSources(join(root, 'components'))
      .filter((file) => localPositionValue.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));

    expect(offenders).toEqual([]);
  });
});
