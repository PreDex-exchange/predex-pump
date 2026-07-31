import { describe, expect, it } from 'vitest';

import {
  compareAuthoritativeFields,
  extractFieldsLocally,
} from '../src/dedup/normalization.js';

describe('deterministic market fact extraction', () => {
  it.each([
    [
      'Will BTC close above $70k Friday?',
      {
        subject: 'btc',
        comparator: 'above',
        strike: 'usd:70000',
        deadline: 'friday',
        basis: 'close',
      },
    ],
    [
      'BTC > $70,000 by Friday close?',
      {
        subject: 'btc',
        comparator: 'above',
        strike: 'usd:70000',
        deadline: 'friday',
        basis: 'close',
      },
    ],
    [
      'Will ETH touch $3.5k at any time before 2026-08-31?',
      {
        subject: 'eth',
        comparator: 'reach',
        strike: 'usd:3500',
        deadline: '2026-08-31',
        basis: 'intraday',
      },
    ],
    [
      'Will Argentina win the World Cup in 2026?',
      {
        subject: 'argentina',
        comparator: 'win',
        strike: null,
        deadline: '2026',
        basis: null,
      },
    ],
    [
      'Will the first market graduate?',
      {
        subject: 'first market',
        comparator: 'graduate',
        strike: null,
        deadline: null,
        basis: null,
      },
    ],
  ])('extracts %s', (question, expected) => {
    expect(extractFieldsLocally(question)).toEqual(expected);
  });

  it('makes every one-sided or conflicting structured field authoritative', () => {
    const base = extractFieldsLocally('Will BTC close above $70k Friday?');
    expect(
      compareAuthoritativeFields(
        base,
        extractFieldsLocally('Will BTC close above $75k Friday?'),
      ),
    ).toMatchObject({ compatible: false, reason: expect.stringContaining('strike') });
    expect(
      compareAuthoritativeFields(
        base,
        extractFieldsLocally('Will BTC be above $70k Friday?'),
      ),
    ).toMatchObject({ compatible: false, reason: expect.stringContaining('basis') });
    expect(
      compareAuthoritativeFields(
        extractFieldsLocally('Will BTC close above $70k tomorrow?'),
        extractFieldsLocally('BTC > $70,000 by tomorrow close?'),
      ),
    ).toMatchObject({
      compatible: false,
      reason: expect.stringContaining('relative deadline'),
    });
  });
});
