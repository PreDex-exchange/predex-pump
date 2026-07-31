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

  // The gate is split by field type: objective fields (strike/deadline/basis
  // and a DIRECTIONAL comparator) are hard gated, while subject naming and
  // comparator phrasing are deferred to a semantic judge. Requiring exact
  // string equality on those rejected true duplicates, because extractors
  // emit unstable surface forms for one entity.
  it('defers subject naming and comparator phrasing, but hard-gates direction', () => {
    const base = {
      subject: 'manchester united',
      comparator: 'win',
      strike: null,
      deadline: '2027',
      basis: null,
    };
    // Same fact, different surface form for the entity → judge decides.
    expect(
      compareAuthoritativeFields(base, { ...base, subject: 'man utd' }),
    ).toMatchObject({ compatible: true, needsSemanticJudgment: true });
    // Comparator absent on one side is phrasing, not a fact difference.
    expect(
      compareAuthoritativeFields(base, { ...base, comparator: null }),
    ).toMatchObject({ compatible: true, needsSemanticJudgment: true });
    // Direction is objective and must never be deferred.
    const priced = { ...base, comparator: 'above', strike: 'usd:70000' };
    expect(
      compareAuthoritativeFields(priced, { ...priced, comparator: 'below' }),
    ).toMatchObject({ compatible: false });
    // Identical fields need no judgment at all.
    const identical = compareAuthoritativeFields(priced, { ...priced });
    expect(identical).toMatchObject({ compatible: true });
    expect(identical.needsSemanticJudgment).toBeUndefined();
  });

  // Regression: "this friday" used to canonicalize differently from a bare
  // "friday", so genuine same-fact duplicates were rejected and the merge
  // router never fired on natural phrasing. "next friday" must stay distinct.
  it('treats "this <weekday>" as the bare weekday but keeps "next" distinct', () => {
    expect(
      compareAuthoritativeFields(
        extractFieldsLocally('Will BTC close above $70k this Friday?'),
        extractFieldsLocally('Will Bitcoin close above $70,000 on Friday?'),
      ),
    ).toMatchObject({ compatible: true });
    expect(
      compareAuthoritativeFields(
        extractFieldsLocally('Will BTC close above $70k this Friday?'),
        extractFieldsLocally('Will BTC close above $70k next Friday?'),
      ),
    ).toMatchObject({
      compatible: false,
      reason: expect.stringContaining('deadline'),
    });
  });
});
