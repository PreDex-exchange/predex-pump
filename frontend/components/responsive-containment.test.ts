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
  it('prevents arbitrary form input from widening the page body', () => {
    const base = source('styles/base.css');
    const create = source('components/create/CreateScreen.module.css');

    expect(rule(base, 'html')).toContain('overflow-x: clip');
    expect(rule(base, 'body')).toContain('overflow-x: clip');
    expect(rule(create, '.page')).toContain('min-width: 0');
    expect(rule(create, '.previewMeta > span:last-child')).toContain(
      'overflow-wrap: anywhere',
    );
  });

  it('wraps an accepted unbroken question inside a feed card', () => {
    const css = source('components/feed/MarketCard.module.css');

    expect(rule(css, '.card h2')).toContain('overflow-wrap: anywhere');
  });

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

  it('allows the Gateway amount flex group to shrink inside a 320px account card', () => {
    const css = source('components/account/GatewayDepositPanel.module.css');

    expect(rule(css, '.amountField')).toContain('min-width: 0');
    expect(rule(css, '.amountInput')).toContain('width: 100%');
    expect(rule(css, '.amountInput')).toContain('min-width: 0');
    expect(rule(css, '.amountInput')).toContain('max-width: 100%');
    expect(rule(css, '.amountInput input')).toContain('min-width: 0');
    expect(rule(css, '.amountInput b')).toContain('flex: none');
  });

  it('keeps the feed activity market link reachable at a 390px viewport', () => {
    const css = source('components/feed/ActivityList.module.css');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 480px)'));

    expect(mobileBlock).toContain('.text');
    expect(mobileBlock).toContain('white-space: normal');
    expect(mobileBlock).toContain('overflow: visible');
    expect(mobileBlock).toContain('.marketLink');
    expect(mobileBlock).toContain('overflow-wrap: anywhere');
  });
});
