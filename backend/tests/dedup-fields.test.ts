import { describe, expect, it } from 'vitest';

import {
  compareAuthoritativeFields,
  compareMarketQuestionFacts,
  extractFieldsLocally,
  groundMarketQuestion,
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

  it.each([
    ['over', 'above'],
    ['above', 'above'],
    ['more than', 'above'],
    ['greater than', 'above'],
    ['at least', 'at_or_above'],
    ['at or above', 'at_or_above'],
  ])('normalizes the stated comparator "%s" to %s', (wording, comparator) => {
    expect(
      extractFieldsLocally(
        `Will Manchester United score ${wording} 70 Premier League goals?`,
      ),
    ).toMatchObject({ comparator, strike: 'number:70' });
  });

  it('keeps strict-above and at-or-above in distinct existing comparator classes', () => {
    expect(
      compareAuthoritativeFields(
        extractFieldsLocally('Will BTC be above $70k in 2027?'),
        extractFieldsLocally('Will BTC be at least $70k in 2027?'),
      ),
    ).toMatchObject({
      compatible: false,
      reason: expect.stringContaining('comparator'),
    });
  });

  it('marks ungrounded extractor values as inferred and does not hard-gate them', () => {
    const question =
      'Will Manchester United score above 70 Premier League goals in the 2026-27 season?';
    const draft = groundMarketQuestion(question, {
      subject: 'manchester united',
      comparator: 'above',
      strike: 'number:70',
      deadline: '2027',
      basis: 'official_result',
    });
    const candidate = groundMarketQuestion(question, {
      subject: 'manchester united',
      comparator: 'above',
      strike: 'number:70',
      deadline: '2027',
      basis: 'settlement',
    });

    expect(draft.fieldSources).toMatchObject({
      subject: 'stated',
      comparator: 'stated',
      strike: 'stated',
      deadline: 'stated',
      basis: 'inferred',
    });
    expect(compareMarketQuestionFacts(draft, candidate)).toMatchObject({
      compatible: true,
    });
  });

  it('still hard-gates a genuinely different field stated in both questions', () => {
    const draft = groundMarketQuestion(
      'Will BTC close above $70k Friday?',
    );
    const candidate = groundMarketQuestion(
      'Will BTC settle above $70k Friday?',
    );

    expect(compareMarketQuestionFacts(draft, candidate)).toMatchObject({
      compatible: false,
      reason: expect.stringContaining('basis'),
    });
  });

  it('defers a one-sided stated field instead of turning absence into a conflict', () => {
    const draft = groundMarketQuestion('Will BTC close above $70k Friday?');
    const candidate = groundMarketQuestion('Will BTC be above $70k Friday?');

    expect(compareMarketQuestionFacts(draft, candidate)).toMatchObject({
      compatible: true,
    });
  });

  it('normalizes season ranges while preserving different stated seasons', () => {
    const canonical = groundMarketQuestion(
      'Will Manchester United score above 70 goals in the 2026-27 season?',
    );
    const paraphrase = groundMarketQuestion(
      'Will Man Utd score over 70 goals in the 2026/27 Premier League season?',
    );
    const differentSeason = groundMarketQuestion(
      'Will Man Utd score over 70 goals in the 2027/28 Premier League season?',
    );

    expect(canonical.fields.deadline).toBe('season:2026-2027');
    expect(paraphrase.fields.deadline).toBe('season:2026-2027');
    expect(compareMarketQuestionFacts(canonical, paraphrase)).toMatchObject({
      compatible: true,
    });
    expect(compareMarketQuestionFacts(canonical, differentSeason)).toMatchObject({
      compatible: false,
      reason: expect.stringContaining('deadline'),
    });
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
