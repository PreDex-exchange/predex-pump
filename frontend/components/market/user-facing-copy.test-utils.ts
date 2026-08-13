import { internalIdentifiersInText } from '../../scripts/user-facing-copy-guard.mjs';

const USER_FACING_ATTRIBUTES = [
  'alt',
  'aria-label',
  'placeholder',
  'title',
] as const;

export function internalIdentifiersInRenderedOutput(container: HTMLElement) {
  const copy = container.cloneNode(true) as HTMLElement;

  // Explicit code samples are technical notation, not identifiers presented as prose.
  copy
    .querySelectorAll('code, [aria-hidden="true"]')
    .forEach((node) => node.remove());

  const renderedStrings: string[] = [];
  const textWalker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  let textNode = textWalker.nextNode();
  while (textNode) {
    if (textNode.textContent) renderedStrings.push(textNode.textContent);
    textNode = textWalker.nextNode();
  }

  copy.querySelectorAll<HTMLElement>('*').forEach((element) => {
    USER_FACING_ATTRIBUTES.forEach((attribute) => {
      const value = element.getAttribute(attribute);
      if (value) renderedStrings.push(value);
    });
  });

  return [
    ...new Set(
      renderedStrings
        .flatMap((value) => internalIdentifiersInText(value)),
    ),
  ].sort();
}
