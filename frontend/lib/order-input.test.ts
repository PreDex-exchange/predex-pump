import { describe, expect, it } from 'vitest';

import { snappedOrderSizeInput } from './order-input';

describe('snappedOrderSizeInput', () => {
  it.each([
    [200_500n, '0.2'],
    [999n, '0'],
    [1_234_567n, '1.234'],
  ])('floors %s raw through the shared order-size granularity', (raw, expected) => {
    expect(snappedOrderSizeInput(raw)).toBe(expected);
  });
});
