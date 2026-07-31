import type { MarketFactFields } from '@predex-pump/shared';

const MONTH_NUMBER: Readonly<Record<string, string>> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

const MONTH_PATTERN =
  'january|february|march|april|may|june|july|august|september|october|november|december';

const SUBJECT_ALIASES: readonly {
  canonical: string;
  pattern: RegExp;
}[] = [
  { canonical: 'btc', pattern: /\b(?:bitcoin|btc)\b/u },
  { canonical: 'eth', pattern: /\b(?:ethereum|ether|eth)\b/u },
  { canonical: 'sol', pattern: /\b(?:solana|sol)\b/u },
  { canonical: 'donald trump', pattern: /\b(?:donald\s+trump|trump)\b/u },
  { canonical: 'joe biden', pattern: /\b(?:joe\s+biden|biden)\b/u },
  { canonical: 's&p 500', pattern: /\b(?:s&p\s*500|spx)\b/u },
  { canonical: 'nasdaq 100', pattern: /\b(?:nasdaq\s*100|ndx)\b/u },
];

const COMPARATOR_ALIASES: readonly [RegExp, string][] = [
  [/\b(?:at\s+least|no\s+less\s+than)\b|>=/u, 'at_or_above'],
  [/\b(?:at\s+most|no\s+more\s+than)\b|<=/u, 'at_or_below'],
  [/\b(?:above|over|exceeds?|greater\s+than|higher\s+than)\b|(?<![<>=])>(?!=)/u, 'above'],
  [/\b(?:below|under|less\s+than|lower\s+than)\b|(?<![<>=])<(?!=)/u, 'below'],
  [/\b(?:equals?|equal\s+to|exactly)\b|(?<![<>=])=(?!=)/u, 'equal'],
  [/\b(?:reaches?|hits?|touch(?:es)?)\b/u, 'reach'],
  [/\b(?:wins?|won|becomes?\s+(?:the\s+)?champion)\b/u, 'win'],
  [/\b(?:loses?|lost)\b/u, 'lose'],
  [/\b(?:is\s+elected|be\s+elected|wins?\s+the\s+election)\b/u, 'elected'],
  [/\b(?:outperforms?|beats?)\b/u, 'outperform'],
  [/\b(?:graduates?|graduated)\b/u, 'graduate'],
  [/\b(?:resolves?\s+yes|resolved\s+yes)\b/u, 'resolve_yes'],
  [/\b(?:launches?|launched)\b/u, 'launch'],
  [/\b(?:rains?|rainfall)\b/u, 'rain'],
  [/\b(?:happens?|occurs?|takes?\s+place)\b/u, 'occur'],
];

const BASIS_ALIASES: readonly [RegExp, string][] = [
  [/\b(?:closing\s+price|market\s+close|daily\s+close|friday\s+close|close[sd]?)\b/u, 'close'],
  [/\b(?:intraday|at\s+any\s+time|ever|touch(?:es|ed)?)\b/u, 'intraday'],
  [/\b(?:settlement\s+price|settles?|settlement)\b/u, 'settlement'],
  [/\b(?:official\s+result|certified\s+result)\b/u, 'official_result'],
  [/\b(?:average\s+price|daily\s+average|average)\b/u, 'average'],
];

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'be',
  'by',
  'did',
  'does',
  'for',
  'has',
  'have',
  'in',
  'is',
  'of',
  'on',
  'price',
  'the',
  'to',
  'will',
  'would',
]);

function normalizedText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function canonicalSubjectValue(value: string): string {
  const normalized = normalizedText(value);
  for (const alias of SUBJECT_ALIASES) {
    if (alias.pattern.test(normalized)) return alias.canonical;
  }
  return normalized
    .replace(/^(?:the\s+)?(?:spot\s+)?price\s+of\s+/u, '')
    .replace(/^(?:the\s+)/u, '')
    .replace(/\s+(?:spot\s+)?price$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function extractSubject(question: string): string | null {
  const normalized = normalizedText(question);
  const knownSubjects = SUBJECT_ALIASES.filter(({ pattern }) => pattern.test(normalized)).map(
    ({ canonical }) => canonical,
  );
  if (knownSubjects.length === 1) return knownSubjects[0] ?? null;
  if (knownSubjects.length > 1) return knownSubjects.join(' > ');

  const withoutOpener = normalized.replace(
    /^(?:will|would|does|did|is|are|has|have|can|could)\s+/u,
    '',
  );
  const delimiter =
    /\s+(?:close[sd]?\s+)?(?:be\s+)?(?:at\s+least|at\s+most|above|over|below|under|exceed(?:s)?|reach(?:es)?|hit(?:s)?|touch(?:es)?|win(?:s)?|won|lose(?:s)?|lost|graduate(?:s)?|graduated|launch(?:es)?|launched|outperform(?:s)?|beat(?:s)?|rain(?:s)?|happen(?:s)?|occur(?:s)?)\b|(?:>=|<=|>|<|=)/u;
  const boundary = withoutOpener.search(delimiter);
  if (boundary <= 0) return null;

  const subject = canonicalSubjectValue(withoutOpener.slice(0, boundary));
  return subject === '' || subject === 'it' ? null : subject;
}

function extractComparator(question: string): string | null {
  const normalized = normalizedText(question);
  for (const [pattern, comparator] of COMPARATOR_ALIASES) {
    if (pattern.test(normalized)) return comparator;
  }
  return null;
}

function expandNumber(rawValue: string, rawSuffix = ''): string | null {
  const value = rawValue.replace(/,/gu, '').trim();
  if (!/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const [rawWhole = '0', rawFraction = ''] = value.split('.');
  const whole = rawWhole.replace(/^0+(?=\d)/u, '');
  const digits = `${whole}${rawFraction}`;
  const shift = ({ k: 3, m: 6, b: 9, t: 12 } as const)[
    rawSuffix.toLowerCase() as 'k' | 'm' | 'b' | 't'
  ] ?? 0;
  const decimalPosition = whole.length + shift;
  let expanded: string;
  if (decimalPosition >= digits.length) {
    expanded = `${digits}${'0'.repeat(decimalPosition - digits.length)}`;
  } else if (decimalPosition <= 0) {
    expanded = `0.${'0'.repeat(-decimalPosition)}${digits}`;
  } else {
    expanded = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  }
  const [expandedWhole = '0', expandedFraction = ''] = expanded.split('.');
  const canonicalWhole = expandedWhole.replace(/^0+(?=\d)/u, '') || '0';
  const canonicalFraction = expandedFraction.replace(/0+$/u, '');
  return canonicalFraction === ''
    ? canonicalWhole
    : `${canonicalWhole}.${canonicalFraction}`;
}

function currencyCode(symbolOrCode: string): string {
  const normalized = symbolOrCode.toLowerCase();
  if (normalized === '€' || normalized === 'eur' || normalized.startsWith('euro')) {
    return 'eur';
  }
  if (normalized === '£' || normalized === 'gbp' || normalized.startsWith('pound')) {
    return 'gbp';
  }
  return 'usd';
}

function extractStrike(question: string, comparator: string | null): string | null {
  const normalized = normalizedText(question);
  const prefixed = normalized.match(/([$€£])\s*(\d[\d,]*(?:\.\d+)?)\s*([kmbt])?\b/u);
  if (prefixed !== null) {
    const amount = expandNumber(prefixed[2] ?? '', prefixed[3]);
    return amount === null ? null : `${currencyCode(prefixed[1] ?? '$')}:${amount}`;
  }

  const suffixed = normalized.match(
    /\b(\d[\d,]*(?:\.\d+)?)\s*([kmbt])?\s*(usd|dollars?|eur|euros?|gbp|pounds?)\b/u,
  );
  if (suffixed !== null) {
    const amount = expandNumber(suffixed[1] ?? '', suffixed[2]);
    return amount === null ? null : `${currencyCode(suffixed[3] ?? 'usd')}:${amount}`;
  }

  const percent = normalized.match(/\b(\d[\d,]*(?:\.\d+)?)\s*(?:%|percent)\b/u);
  if (percent !== null) {
    const amount = expandNumber(percent[1] ?? '');
    return amount === null ? null : `percent:${amount}`;
  }

  if (
    comparator !== null &&
    ['above', 'at_or_above', 'at_or_below', 'below', 'equal', 'reach'].includes(
      comparator,
    )
  ) {
    const afterComparator = normalized.match(
      /(?:>=|<=|>|<|=|\b(?:above|over|below|under|exceeds?|greater\s+than|less\s+than|at\s+least|at\s+most|reaches?|hits?)\b)\s*(\d[\d,]*(?:\.\d+)?)\s*([kmbt])?\b/u,
    );
    if (afterComparator !== null) {
      const amount = expandNumber(afterComparator[1] ?? '', afterComparator[2]);
      if (amount !== null) {
        const cryptoSubject = /\b(?:bitcoin|btc|ethereum|ether|eth|solana|sol)\b/u.test(
          normalized,
        );
        return `${cryptoSubject ? 'usd' : 'number'}:${amount}`;
      }
    }
  }
  return null;
}

function formatMonthDate(month: string, day: string, year: string | undefined): string {
  const monthNumber = MONTH_NUMBER[month];
  const dayNumber = day.padStart(2, '0');
  return year === undefined
    ? `${monthNumber ?? month}-${dayNumber}`
    : `${year}-${monthNumber ?? month}-${dayNumber}`;
}

function extractDeadline(question: string): string | null {
  const normalized = normalizedText(question);
  const isoDate = normalized.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/u);
  if (isoDate !== null) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;

  const monthFirst = normalized.match(
    new RegExp(
      `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`,
      'u',
    ),
  );
  if (monthFirst !== null) {
    return formatMonthDate(
      monthFirst[1] ?? '',
      monthFirst[2] ?? '',
      monthFirst[3],
    );
  }

  const dayFirst = normalized.match(
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})(?:,?\\s+(20\\d{2}))?\\b`,
      'u',
    ),
  );
  if (dayFirst !== null) {
    return formatMonthDate(dayFirst[2] ?? '', dayFirst[1] ?? '', dayFirst[3]);
  }

  const quarter = normalized.match(/\bq([1-4])\s+(20\d{2})\b/u);
  if (quarter !== null) return `${quarter[2]}-q${quarter[1]}`;

  const yearEnd = normalized.match(/\b(?:by|before|at)\s+(?:the\s+)?end\s+of\s+(20\d{2})\b/u);
  if (yearEnd !== null) return `${yearEnd[1]}-end`;

  const weekday = normalized.match(
    /\b(?:(next|this)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/u,
  );
  if (weekday !== null) {
    // "this friday" and a bare "friday" both mean the upcoming Friday, so the
    // "this" qualifier is dropped; "next friday" is a genuinely different day
    // and stays distinct.
    const qualifier = weekday[1] === 'next' ? 'next ' : '';
    return weekday[2] === undefined ? null : `${qualifier}${weekday[2]}`;
  }

  const relativeDay = normalized.match(/\b(today|tomorrow|tonight)\b/u);
  if (relativeDay !== null) return `relative:${relativeDay[1]}`;

  const temporalYear = normalized.match(
    /\b(?:by|before|after|during|in|through)\s+(20\d{2})\b/u,
  );
  return temporalYear?.[1] ?? null;
}

function extractBasis(question: string): string | null {
  const normalized = normalizedText(question);
  for (const [pattern, basis] of BASIS_ALIASES) {
    if (pattern.test(normalized)) return basis;
  }
  return null;
}

function canonicalComparatorValue(value: string): string {
  const normalized = normalizedText(value);
  for (const [pattern, comparator] of COMPARATOR_ALIASES) {
    if (pattern.test(normalized)) return comparator;
  }
  return normalized.replace(/\s+/gu, '_');
}

function canonicalStrikeValue(value: string): string {
  const normalized = normalizedText(value);
  if (/^(?:usd|eur|gbp|percent|number):\d+(?:\.\d+)?$/u.test(normalized)) {
    return normalized;
  }
  return extractStrike(normalized, 'equal') ?? normalized.replace(/\s+/gu, '_');
}

function canonicalDeadlineValue(value: string): string {
  const normalized = normalizedText(value);
  return extractDeadline(normalized) ?? normalized;
}

function canonicalBasisValue(value: string): string {
  const normalized = normalizedText(value);
  for (const [pattern, basis] of BASIS_ALIASES) {
    if (pattern.test(normalized)) return basis;
  }
  return normalized.replace(/\s+/gu, '_');
}

function normalizeNullable(
  value: string | null,
  normalize: (input: string) => string,
): string | null {
  if (value === null || value.trim() === '') return null;
  const normalized = normalize(value);
  return normalized === '' ? null : normalized;
}

export function normalizeExtractedFields(fields: MarketFactFields): MarketFactFields {
  return {
    subject: normalizeNullable(fields.subject, canonicalSubjectValue),
    comparator: normalizeNullable(fields.comparator, canonicalComparatorValue),
    strike: normalizeNullable(fields.strike, canonicalStrikeValue),
    deadline: normalizeNullable(fields.deadline, canonicalDeadlineValue),
    basis: normalizeNullable(fields.basis, canonicalBasisValue),
  };
}

export function extractFieldsLocally(question: string): MarketFactFields {
  const comparator = extractComparator(question);
  return {
    subject: extractSubject(question),
    comparator,
    strike: extractStrike(question, comparator),
    deadline: extractDeadline(question),
    basis: extractBasis(question),
  };
}

export interface AuthoritativeComparison {
  compatible: boolean;
  reason: string;
  /**
   * True when every objective field matches but some linguistic field is
   * ambiguous — the subject is named differently ("man_utd" vs
   * "manchester_united"), or the comparator is absent/phrased differently
   * ("win" vs "be champions"). Only a semantic judge may resolve those; a
   * deterministic judge must treat it as not-a-duplicate.
   */
  needsSemanticJudgment?: boolean;
}

/**
 * Comparators that encode a DIRECTION. A mismatch between two of these is an
 * objective difference (above vs below is a different fact), so it is hard
 * gated. Everything else ("win", "reach", "lose", or absent) is verb phrasing
 * and is deferred to the semantic judge.
 */
const DIRECTIONAL_COMPARATORS = new Set([
  'above',
  'below',
  'at_or_above',
  'at_or_below',
  'equal',
]);

/**
 * Objective fields. A difference here means a genuinely different real-world
 * fact ($70k vs $75k, Friday vs Saturday), so they are a hard gate that no
 * similarity score or model judgment may override.
 *
 * `subject` is deliberately NOT in this list: extractors — especially model
 * backed ones — emit unstable surface forms for the same entity, so requiring
 * exact string equality rejected true duplicates. It is handled separately.
 */
const AUTHORITATIVE_FIELDS = [
  'strike',
  'deadline',
  'basis',
] as const satisfies readonly (keyof MarketFactFields)[];

/**
 * Objective fields are a hard gate: a conflict, or a field present on only one
 * side, can never be overridden by vector similarity or a model judgment.
 *
 * `subject` is a softer gate. It must be established on BOTH sides, but when the
 * two sides merely NAME it differently the decision is deferred to the caller's
 * semantic judge via `subjectNeedsJudgment` — extractors emit unstable surface
 * forms ("man_utd" vs "manchester_united") for one entity, and demanding exact
 * equality rejected true duplicates. Deterministic judges must treat that flag
 * as not-a-duplicate; only a semantic judge may equate the two.
 */
export function compareAuthoritativeFields(
  draft: MarketFactFields,
  candidate: MarketFactFields,
): AuthoritativeComparison {
  if (draft.subject === null && candidate.subject === null) {
    return {
      compatible: false,
      reason: 'Cannot establish subject; conservative not-duplicate decision',
    };
  }
  if (draft.subject === null || candidate.subject === null) {
    return {
      compatible: false,
      reason: 'Different subject: one question does not specify it',
    };
  }
  let needsSemanticJudgment = draft.subject !== candidate.subject;

  // Comparator: a directional mismatch is objective and fatal; absent or
  // differently-phrased comparators are linguistic and go to the judge.
  const draftComparator = draft.comparator;
  const candidateComparator = candidate.comparator;
  if (draftComparator !== candidateComparator) {
    if (
      draftComparator !== null &&
      candidateComparator !== null &&
      DIRECTIONAL_COMPARATORS.has(draftComparator) &&
      DIRECTIONAL_COMPARATORS.has(candidateComparator)
    ) {
      return {
        compatible: false,
        reason: `Different comparator: "${draftComparator}" vs "${candidateComparator}"`,
      };
    }
    needsSemanticJudgment = true;
  } else if (draftComparator === null) {
    // Neither question states a comparison; only a semantic judge can tell
    // "announce" from "release".
    needsSemanticJudgment = true;
  }

  for (const field of AUTHORITATIVE_FIELDS) {
    const draftValue = draft[field];
    const candidateValue = candidate[field];
    if (draftValue === null && candidateValue === null) {
      continue;
    }
    if (draftValue === null || candidateValue === null) {
      return {
        compatible: false,
        reason: `Different ${field}: one question does not specify it`,
      };
    }
    if (draftValue !== candidateValue) {
      return {
        compatible: false,
        reason: `Different ${field}: "${draftValue}" vs "${candidateValue}"`,
      };
    }
    if (field === 'deadline' && draftValue.startsWith('relative:')) {
      return {
        compatible: false,
        reason: `Cannot resolve relative deadline "${draftValue}" conservatively`,
      };
    }
  }
  return needsSemanticJudgment
    ? {
        compatible: true,
        needsSemanticJudgment: true,
        reason:
          'Objective fields (strike, deadline, basis, direction) match; ' +
          'subject naming or comparator phrasing needs semantic judgment',
      }
    : {
        compatible: true,
        reason: 'All authoritative structured fields match',
      };
}

function canonicalizeAliases(value: string): string {
  let normalized = normalizedText(value)
    .replace(/>=/gu, ' at_or_above ')
    .replace(/<=/gu, ' at_or_below ')
    .replace(/(?<![<>=])>(?!=)/gu, ' above ')
    .replace(/(?<![<>=])<(?!=)/gu, ' below ')
    .replace(/\b(?:bitcoin)\b/gu, 'btc')
    .replace(/\b(?:ethereum|ether)\b/gu, 'eth')
    .replace(/\b(?:greater\s+than|higher\s+than|over|exceeds?)\b/gu, 'above')
    .replace(/\b(?:less\s+than|lower\s+than|under)\b/gu, 'below')
    .replace(/\b(?:closing|closed|closes)\b/gu, 'close')
    .replace(/\b(?:becomes?\s+(?:the\s+)?champion|champions?)\b/gu, 'win')
    .replace(/,/gu, '');
  normalized = normalized.replace(
    /\b(\d+(?:\.\d+)?)\s*([kmbt])\b/gu,
    (_match, amount: string, suffix: string) => expandNumber(amount, suffix) ?? amount,
  );
  return normalized;
}

export function canonicalQuestionTokens(question: string): string[] {
  return canonicalizeAliases(question)
    .replace(/[$€£%]/gu, ' ')
    .match(/[a-z0-9]+(?:_[a-z0-9]+)*/gu)
    ?.map((token) => {
      if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
      if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
      return token;
    })
    .filter((token) => !STOP_WORDS.has(token)) ?? [];
}

export function tokenSimilarity(leftQuestion: string, rightQuestion: string): number {
  const left = new Set(canonicalQuestionTokens(leftQuestion));
  const right = new Set(canonicalQuestionTokens(rightQuestion));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / Math.max(left.size, right.size);
}
