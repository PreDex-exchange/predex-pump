import { describe, expect, it } from 'vitest';

import {
  snappedOrderSizeInput,
  validateOrderPriceInput,
} from './order-input';

describe('snappedOrderSizeInput', () => {
  it.each([
    [200_500n, '0.2'],
    [500n, '0.0005'],
    [999n, '0.000999'],
    [1_234_567n, '1.234'],
  ])('preserves sub-step values or floors %s to a positive valid step', (raw, expected) => {
    expect(snappedOrderSizeInput(raw)).toBe(expected);
  });
});

describe('validateOrderPriceInput', () => {
  it('reports distinct, truthful failures for independent price conditions', () => {
    const cases = [
      {
        input: '1.001',
        expected: 'Price must be at most 1 USDC',
        absent: /tick/u,
      },
      {
        input: '0.0005',
        expected:
          'Price must use 0.001 USDC ticks. Nearest valid price: 0.001000',
        absent: /at most|greater than/u,
      },
      {
        input: '0.000',
        expected: 'Price must be greater than 0 USDC',
        absent: /tick/u,
      },
      {
        input: '-0.5',
        expected: 'Price cannot be negative',
        absent: /tick/u,
      },
      {
        input: 'abc',
        expected: 'Enter a numeric price',
        absent: /tick|at most|greater than/u,
      },
    ] as const;

    const messages = cases.map(({ input, expected, absent }) => {
      const validation = validateOrderPriceInput(input, 1_000n);
      expect(validation.error).toBe(expected);
      expect(validation.error).not.toMatch(absent);
      return validation.error;
    });

    expect(new Set(messages).size).toBe(cases.length);
  });

  it('names the nearest valid tick for a copied off-tick ladder price', () => {
    expect(validateOrderPriceInput('0.543213', 1_000n)).toEqual({
      raw: 543_213n,
      error:
        'Price must use 0.001 USDC ticks. Nearest valid price: 0.543000',
    });
  });
});
