import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

const frontendRoot = process.cwd();

function css(path: string) {
  return readFileSync(`${frontendRoot}/${path}`, 'utf8');
}

function focusVisual(element: Element) {
  const computed = getComputedStyle(element);
  return {
    boxShadow: computed.boxShadow,
    outline: computed.outline,
    outlineColor: computed.outlineColor,
    outlineOffset: computed.outlineOffset,
    outlineStyle: computed.outlineStyle,
    outlineWidth: computed.outlineWidth,
  };
}

function mountStyles() {
  const style = document.createElement('style');
  // jsdom does not recalculate pseudo-class styles for :focus-visible. Keep
  // the production declarations intact and substitute only the selector for
  // this computed-style assertion.
  style.textContent = [
    css('styles/tokens.css'),
    css('styles/base.css'),
    css('components/feed/FeedScreen.module.css'),
    css('components/layout/AppHeader.module.css'),
  ]
    .join('\n')
    .replaceAll(':focus-visible', '.__computedFocusVisible');
  document.head.append(style);
}

function expectVisibleFocusWithoutShadowLoss(element: HTMLElement) {
  const unfocused = focusVisual(element);
  element.classList.add('__computedFocusVisible');
  const focused = focusVisual(element);

  expect(focused).not.toEqual(unfocused);
  expect(focused.outline).not.toBe(unfocused.outline);
  expect(focused.outline).toContain('solid');
  expect(focused.boxShadow).toBe(unfocused.boxShadow);
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('chunky controls focus visibility', () => {
  it('computes a visible focus change for all four filters while preserving their offset shadows', () => {
    mountStyles();
    document.body.innerHTML = `
      <div class="filters">
        <button class="active" type="button">All</button>
        <button type="button">Bootstrap</button>
        <button type="button">Graduated</button>
        <button type="button">Resolved</button>
      </div>
    `;
    const filters = document.querySelectorAll<HTMLButtonElement>('button');
    expect(filters).toHaveLength(4);

    filters.forEach(expectVisibleFocusWithoutShadowLoss);
  });

  it('computes a visible focus change for the active navigation link while preserving its offset shadow', () => {
    mountStyles();
    document.body.innerHTML =
      '<a class="navLink active" href="/">Feed</a>';
    const link = document.querySelector<HTMLAnchorElement>('a');
    expect(link).not.toBeNull();

    expectVisibleFocusWithoutShadowLoss(link as HTMLAnchorElement);
  });
});
