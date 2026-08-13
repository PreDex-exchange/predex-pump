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

const defaultComponentStyles = [
  'components/feed/FeedScreen.module.css',
  'components/layout/AppHeader.module.css',
  'components/layout/WalletBar.module.css',
];

function mountStyles(componentStyles = defaultComponentStyles) {
  const style = document.createElement('style');
  // jsdom does not recalculate pseudo-class styles for :focus-visible. Keep
  // the production declarations intact and substitute only the selector for
  // this computed-style assertion.
  style.textContent = [
    css('styles/tokens.css'),
    css('styles/base.css'),
    ...componentStyles.map(css),
  ]
    .join('\n')
    .replaceAll(':focus-visible', '.__computedFocusVisible')
    .replaceAll(':focus-within', '.__computedFocusWithin')
    .replaceAll(':hover', '.__computedHover');
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

  it('keeps a real outline when a pointer hover overrides the wallet control shadow', () => {
    mountStyles();
    document.body.innerHTML =
      '<button class="auth __computedHover" type="button">Signed in</button>';
    const button = document.querySelector<HTMLButtonElement>('button');
    expect(button).not.toBeNull();

    expectVisibleFocusWithoutShadowLoss(button as HTMLButtonElement);
  });
});

const wrappedControlFixtures = [
  {
    name: '/market/16 Hybrid limit price, size, and expiry',
    stylesheet: 'components/market/HybridOrderBookPanel.module.css',
    markup: `
      <span class="input"><input aria-label="Limit price"></span>
      <span class="input"><input aria-label="Size"></span>
      <span class="input"><input aria-label="Expiry"></span>
    `,
    wrapperSelector: '.input',
  },
  {
    name: '/market/17 order-book limit price and size',
    stylesheet: 'components/market/OrderBookPanel.module.css',
    markup: `
      <span class="input"><input aria-label="Limit price"></span>
      <span class="input"><input aria-label="Size"></span>
    `,
    wrapperSelector: '.input',
  },
  {
    name: '/market/15 shares to buy',
    stylesheet: 'components/market/TradePanel.module.css',
    markup: '<span class="input"><input aria-label="Shares to buy"></span>',
    wrapperSelector: '.input',
  },
  {
    name: '/ sort select',
    stylesheet: 'components/feed/FeedScreen.module.css',
    markup:
      '<label class="sort"><select aria-label="Sort markets"><option>Newest</option></select></label>',
    wrapperSelector: '.sort',
  },
  {
    name: '/account deposit amount',
    stylesheet: 'components/account/GatewayDepositPanel.module.css',
    markup:
      '<span class="amountInput"><input aria-label="Deposit amount"></span>',
    wrapperSelector: '.amountInput',
  },
];

describe('wrapped input focus visibility', () => {
  it('covers the eight shipped affected controls', () => {
    const count = wrappedControlFixtures.reduce((total, fixture) => {
      document.body.innerHTML = fixture.markup;
      return total + document.querySelectorAll('input, select').length;
    }, 0);

    expect(count).toBe(8);
  });

  it.each(wrappedControlFixtures)(
    'computes a persistent focus indicator for $name, including while hovered',
    ({ markup, stylesheet, wrapperSelector }) => {
      mountStyles([stylesheet]);
      document.body.innerHTML = markup;
      const controls = document.querySelectorAll<HTMLElement>('input, select');
      expect(controls.length).toBeGreaterThan(0);

      controls.forEach((control) => {
        const wrapper = control.closest<HTMLElement>(wrapperSelector);
        expect(wrapper).not.toBeNull();
        if (wrapper === null) return;

        const unfocused = focusVisual(wrapper);
        control.classList.add('__computedFocusVisible');
        wrapper.classList.add('__computedFocusWithin');
        const focused = focusVisual(wrapper);

        expect(focused.boxShadow).not.toBe(unfocused.boxShadow);
        expect(focused.boxShadow).not.toBe('none');

        control.classList.remove('__computedFocusVisible');
        wrapper.classList.remove('__computedFocusWithin');
        control.classList.add('__computedHover');
        wrapper.classList.add('__computedHover');
        const hovered = focusVisual(wrapper);

        control.classList.add('__computedFocusVisible');
        wrapper.classList.add('__computedFocusWithin');
        const hoveredAndFocused = focusVisual(wrapper);

        expect(hoveredAndFocused.boxShadow).toBe(focused.boxShadow);
        expect(hoveredAndFocused.boxShadow).not.toBe(hovered.boxShadow);
      });
    },
  );
});
