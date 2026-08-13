import { describe, expect, it } from 'vitest';

import {
  formatCompactUsdc,
  formatDateTime,
  formatImpliedPercent,
  formatPrice,
  formatShareQuantity,
  formatUsd,
  formatUsdc,
} from './format';

describe('fixed-precision money formatting', () => {
  it.each([
    ['0', '0.00'],
    ['1', '<0.01'],
    ['4000', '<0.01'],
    ['5000', '0.01'],
    ['999999', '1.00'],
    ['123456789012', '123,456.79'],
  ])('formats raw USDC %s as %s', (raw, expected) => {
    expect(formatUsdc(raw, 2)).toBe(expected);
  });

  it('places a dollar sign after the floor indicator', () => {
    expect(formatUsd('0')).toBe('$0.00');
    expect(formatUsd('4000')).toBe('<$0.01');
  });

  it('uses the same non-zero floor for fixed-precision prices', () => {
    expect(formatPrice('0')).toBe('0.00');
    expect(formatPrice('4000')).toBe('<0.01');
  });

  it('does not collapse non-zero compact money to zero', () => {
    expect(formatCompactUsdc('0')).toBe('0');
    expect(formatCompactUsdc('1')).toBe('<1');
  });

  it('does not describe a non-zero implied probability as impossible', () => {
    expect(formatImpliedPercent('0')).toBe('0');
    expect(formatImpliedPercent('1')).toBe('<1');
  });

  it('does not describe a non-zero share quantity as empty', () => {
    expect(formatShareQuantity('0')).toBe('0.00');
    expect(formatShareQuantity('1')).toBe('<0.01');
  });
});

describe('absolute date formatting', () => {
  it('renders the instant in UTC and names the zone', () => {
    const formatted = formatDateTime(0);

    expect(formatted).toContain('Jan 1, 1970');
    expect(formatted).toContain('12:00 AM');
    expect(formatted).toMatch(/\bUTC$/u);
  });
});
