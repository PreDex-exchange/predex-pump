import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(`${process.cwd()}/${path}`, 'utf8');
}

function rule(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'u'))?.[1] ?? '';
}

describe('responsive containment contracts', () => {
  it.each([390, 1024])(
    'contains an unbroken market question at a %ipx viewport',
    () => {
      const css = source('components/market/MarketScreen.module.css');
      const page = rule(css, '.page');
      const question = rule(css, '.marketHeader h1');
      const grid = rule(css, '.grid');

      expect(page).toContain('min-width: 0');
      expect(page).toContain('overflow-x: clip');
      expect(question).toContain('max-width: min(26ch, 100%)');
      expect(question).toContain('overflow-wrap: anywhere');
      expect(question).toContain('word-break: break-word');
      expect(grid).toContain('min-width: 0');
    },
  );

  it('keeps the wide MiniCLOB raw-order row inside its own scroller', () => {
    const css = source('components/market/OrderBookPanel.module.css');
    const table = rule(css, '.orderTable');
    const row = rule(css, '.orderRow');

    expect(table).toContain('max-width: 100%');
    expect(table).toContain('min-width: 0');
    expect(table).toContain('overflow-x: auto');
    expect(row).toContain('min-width: 700px');
  });

  it('shows all five primary destinations in a width-constrained mobile grid', () => {
    const css = source('components/layout/AppHeader.module.css');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 700px)'));

    expect(mobileBlock).toContain('grid-template-columns: repeat(5, minmax(0, 1fr))');
    expect(mobileBlock).toContain('overflow-x: visible');
    expect(mobileBlock).toContain('white-space: normal');
  });

  it('keeps populated portfolio rows inside the mobile card width', () => {
    const css = source('components/portfolio/PortfolioScreen.module.css');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 760px)'));

    expect(rule(css, '.tableCard')).toContain('max-width: 100%');
    expect(mobileBlock).toContain('overflow: hidden');
    expect(mobileBlock).toContain('max-width: 100%');
    expect(mobileBlock).toContain('overflow-wrap: anywhere');
  });
});
