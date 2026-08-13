import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const CODE_IDENTIFIER_PATTERN =
  /\b(?:[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)\b/gu;
const ALLOWED_USER_FACING_TERMS = new Set([
  'MiniCLOB',
  'PnL',
  'USDC',
  'LMSR',
]);
const USER_FACING_ATTRIBUTES = new Set([
  'alt',
  'aria-label',
  'description',
  'detail',
  'empty',
  'emptyMessage',
  'kicker',
  'label',
  'message',
  'placeholder',
  'title',
]);

export function internalIdentifiersInText(value) {
  return [
    ...new Set(
      (value.match(CODE_IDENTIFIER_PATTERN) ?? []).filter(
        (identifier) => !ALLOWED_USER_FACING_TERMS.has(identifier),
      ),
    ),
  ].sort();
}

function ariaHidden(openingElement, sourceFile) {
  return openingElement.attributes.properties.some((property) => {
    if (
      !ts.isJsxAttribute(property) ||
      property.name.getText(sourceFile) !== 'aria-hidden'
    ) {
      return false;
    }
    if (!property.initializer) return true;
    if (ts.isStringLiteral(property.initializer)) {
      return property.initializer.text === 'true';
    }
    return property.initializer.getText(sourceFile) === '{true}';
  });
}

function excludedFromProse(node, sourceFile) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    const openingElement = ts.isJsxElement(parent)
      ? parent.openingElement
      : ts.isJsxSelfClosingElement(parent)
        ? parent
        : null;
    if (!openingElement) continue;
    if (openingElement.tagName.getText(sourceFile).toLowerCase() === 'code') {
      return true;
    }
    if (ariaHidden(openingElement, sourceFile)) return true;
  }
  return false;
}

function inUserFacingJsx(node, sourceFile) {
  if (ts.isJsxAttribute(node.parent)) {
    return USER_FACING_ATTRIBUTES.has(node.parent.name.getText(sourceFile));
  }
  if (!ts.isJsxExpression(node.parent) || node.parent.expression !== node) {
    return false;
  }
  const jsxParent = node.parent.parent;
  if (ts.isJsxAttribute(jsxParent)) {
    return USER_FACING_ATTRIBUTES.has(jsxParent.name.getText(sourceFile));
  }
  return ts.isJsxElement(jsxParent) || ts.isJsxFragment(jsxParent);
}

function moduleSpecifier(node) {
  return (
    (ts.isImportDeclaration(node.parent) && node.parent.moduleSpecifier === node) ||
    (ts.isExportDeclaration(node.parent) && node.parent.moduleSpecifier === node)
  );
}

export function internalIdentifiersInTsxSource(
  sourceText,
  filePath = 'component.tsx',
) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations = [];
  const seen = new Set();

  function record(value, node) {
    if (excludedFromProse(node, sourceFile)) return;
    const identifiers = internalIdentifiersInText(value);
    if (identifiers.length === 0) return;
    const position = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    const key = `${position.line}:${position.character}:${identifiers.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({
      column: position.character + 1,
      filePath,
      identifiers,
      line: position.line + 1,
      text: value.trim().replace(/\s+/gu, ' '),
    });
  }

  function visit(node) {
    if (ts.isJsxText(node)) {
      record(node.getText(sourceFile), node);
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !moduleSpecifier(node) &&
      (/\s/u.test(node.text) || inUserFacingJsx(node, sourceFile))
    ) {
      record(node.text, node);
    } else if (
      (ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      (/\s/u.test(node.text) || inUserFacingJsx(node, sourceFile))
    ) {
      record(node.text, node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function productionTsxFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTsxFiles(fullPath);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.')
      ? [fullPath]
      : [];
  });
}

export function userFacingCopyViolations(frontendRoot) {
  return ['app', 'components']
    .flatMap((directory) =>
      productionTsxFiles(path.join(frontendRoot, directory)),
    )
    .flatMap((filePath) =>
      internalIdentifiersInTsxSource(readFileSync(filePath, 'utf8'), filePath),
    );
}

export function assertUserFacingCopy(frontendRoot) {
  const violations = userFacingCopyViolations(frontendRoot);
  if (violations.length === 0) return;
  const details = violations.map(
    ({ column, filePath, identifiers, line, text }) =>
      `${path.relative(frontendRoot, filePath)}:${line}:${column} ` +
      `${identifiers.join(', ')} in “${text}”`,
  );
  throw new Error(
    `User-facing prose contains code identifiers:\n${details.join('\n')}\n` +
      'Rewrite them in plain English or mark genuine code with <code>.',
  );
}
