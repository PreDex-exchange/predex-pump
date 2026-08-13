import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function productionTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTsxFiles(fullPath);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.')
      ? [fullPath]
      : [];
  });
}

function attribute(
  element: ts.JsxSelfClosingElement,
  name: string,
) {
  return element.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function canRenderError(attributeNode: ts.JsxAttribute | undefined) {
  if (!attributeNode?.initializer) return false;
  if (ts.isStringLiteral(attributeNode.initializer)) {
    return attributeNode.initializer.text === 'error';
  }
  return attributeNode.initializer.getText().includes("'error'") ||
    attributeNode.initializer.getText().includes('"error"');
}

describe('StatePanel error action contract', () => {
  it('gives every error-capable StatePanel across the app an action', () => {
    const roots = ['app', 'components'].map((directory) =>
      path.join(process.cwd(), directory),
    );
    const violations: string[] = [];
    let errorPanelCount = 0;

    for (const filePath of roots.flatMap(productionTsxFiles)) {
      const sourceText = readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );

      function visit(node: ts.Node) {
        if (
          ts.isJsxSelfClosingElement(node) &&
          node.tagName.getText(sourceFile) === 'StatePanel' &&
          canRenderError(attribute(node, 'state'))
        ) {
          errorPanelCount += 1;
          if (!attribute(node, 'actions')) {
            const line =
              sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
              1;
            violations.push(`${path.relative(process.cwd(), filePath)}:${line}`);
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    expect(errorPanelCount).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
