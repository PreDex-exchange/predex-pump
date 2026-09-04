import type { ActivityEvent, Market } from '@predex-pump/shared/domain';

import {
  formatDateTime,
  formatShareQuantity,
  formatUsd,
  formatUsdc,
  relativeTime,
  shortAddress,
} from './format';

export type ActivityTone =
  | 'cancelled'
  | 'created'
  | 'graduated'
  | 'filled'
  | 'resolved';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/iu;

export type ActivityActorKind = 'agent' | 'human' | 'protocol';

export function parseAgentAddresses(value: string | undefined) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((address) => address.trim().toLowerCase())
      .filter((address) => ADDRESS_PATTERN.test(address)),
  );
}

export function activityActorKind(
  event: ActivityEvent,
  agentAddresses: ReadonlySet<string>,
): ActivityActorKind {
  if (event.account === null) return 'protocol';
  return agentAddresses.has(event.account.toLowerCase()) ? 'agent' : 'human';
}

export function spokenActivityActor(
  event: ActivityEvent,
  kind: ActivityActorKind,
) {
  if (event.account === null) return 'Protocol';
  return `${kind === 'agent' ? 'Agent' : 'Human'} ${shortAddress(
    event.account,
    5,
    4,
  )}`;
}

export type ActivityDescriptionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'value'; text: string }
  | { href: string | null; kind: 'market'; text: string };

export interface ActivityDescription {
  label: string;
  segments: ActivityDescriptionSegment[];
  text: string;
  time: {
    compact: string;
    dateTime: string;
    full: string;
  };
  tone: ActivityTone;
}

function text(value: string): ActivityDescriptionSegment {
  return { kind: 'text', text: value };
}

function value(valueText: string): ActivityDescriptionSegment {
  return { kind: 'value', text: valueText };
}

function marketSegment(
  event: ActivityEvent,
  markets: readonly Market[],
): ActivityDescriptionSegment {
  if (event.marketId === null) {
    return { href: null, kind: 'market', text: 'the protocol' };
  }
  const label =
    markets.find((market) => market.id === event.marketId)?.question ??
    `market #${event.marketId}`;
  return {
    href: `/market/${event.marketId}`,
    kind: 'market',
    text: `“${label}”`,
  };
}

function quantity(event: ActivityEvent) {
  if (event.amountRaw === undefined) return null;
  return formatShareQuantity(event.amountRaw, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function estimatedNotional(event: ActivityEvent) {
  if (event.amountRaw === undefined || event.priceRaw === undefined) return null;
  try {
    return (
      (BigInt(event.amountRaw) * BigInt(event.priceRaw) + 500_000n) /
      1_000_000n
    ).toString();
  } catch {
    return null;
  }
}

function finishDescription(
  event: ActivityEvent,
  label: string,
  tone: ActivityTone,
  segments: ActivityDescriptionSegment[],
): ActivityDescription {
  return {
    label,
    segments,
    text: segments.map((segment) => segment.text).join(''),
    time: {
      compact: relativeTime(event.ts).replace(' ago', ''),
      dateTime: new Date(event.ts * 1_000).toISOString(),
      full: formatDateTime(event.ts),
    },
    tone,
  };
}

/**
 * Canonical activity vocabulary. Surfaces choose compact or full layout, but
 * badges, action wording, values, market links, and timestamp data originate
 * from this one description.
 */
export function describeActivityEvent(
  event: ActivityEvent,
  markets: readonly Market[],
): ActivityDescription {
  const amount = quantity(event);
  const price =
    event.priceRaw === undefined ? null : formatUsd(event.priceRaw);
  const notional = estimatedNotional(event);
  const market = marketSegment(event, markets);
  const outcomeAmount = `${amount ?? '—'}${
    event.outcome ? ` ${event.outcome}` : ''
  }`;

  switch (event.type) {
    case 'MarketCreated':
      return finishDescription(event, 'Created', 'created', [
        text('created '),
        market,
        text(' and opened its LMSR curve.'),
      ]);
    case 'Trade': {
      const verb =
        event.side === 'ASK'
          ? 'sold'
          : event.side === 'BID'
            ? 'bought'
            : 'traded';
      return finishDescription(event, 'Trade', 'filled', [
        text(`${verb} `),
        value(outcomeAmount),
        text(' shares on '),
        market,
        ...(price ? [text(' at '), value(price)] : []),
        ...(notional
          ? [text(' for about '), value(`${formatUsdc(notional)} USDC`)]
          : []),
        text('.'),
      ]);
    }
    case 'OrderPlaced': {
      const orderKind =
        event.side === 'ASK'
          ? 'ask'
          : event.side === 'BID'
            ? 'bid'
            : 'order';
      return finishDescription(event, 'Order', 'filled', [
        text('placed a '),
        value(outcomeAmount),
        text(` ${orderKind} on `),
        market,
        ...(price ? [text(' at '), value(price)] : []),
        text('.'),
      ]);
    }
    case 'OrderFilled':
      return finishDescription(event, 'Filled', 'filled', [
        text('filled '),
        value(outcomeAmount),
        text(' shares from the order book on '),
        market,
        ...(price ? [text(' at '), value(price)] : []),
        ...(notional
          ? [text(' for about '), value(`${formatUsdc(notional)} USDC`)]
          : []),
        text('.'),
      ]);
    case 'OrderCancelled': {
      if (amount === null) {
        return finishDescription(
          event,
          'Cancelled',
          'cancelled',
          event.outcome
            ? [
                text('cancelled a '),
                value(event.outcome),
                text(' order on '),
                market,
                text('.'),
              ]
            : [text('cancelled an order on '), market, text('.')],
        );
      }
      const orderKind =
        event.side === 'ASK'
          ? 'ask'
          : event.side === 'BID'
            ? 'bid'
            : 'order';
      return finishDescription(event, 'Cancelled', 'cancelled', [
        text('cancelled a '),
        value(outcomeAmount),
        text(` ${orderKind} on `),
        market,
        text('.'),
      ]);
    }
    case 'MarketGraduated':
      return finishDescription(event, 'Graduated', 'graduated', [
        text('graduated '),
        market,
        text(' from the LMSR curve to its order book.'),
      ]);
    case 'BookSeeded':
      return finishDescription(event, 'Book seeded', 'graduated', [
        text('seeded the first order-book depth on '),
        market,
        ...(amount
          ? [text(' with '), value(amount), text(' complete sets')]
          : []),
        text('.'),
      ]);
    case 'ResolutionObserved':
      return finishDescription(event, 'Resolved', 'resolved', [
        text('observed the '),
        value(event.outcome ?? 'committee'),
        text(' resolution for '),
        market,
        text('.'),
      ]);
    case 'Closeout':
      return finishDescription(event, 'Closed out', 'resolved', [
        text('closed out '),
        market,
        text(' on-chain.'),
      ]);
    case 'Redeem':
      return finishDescription(event, 'Redeemed', 'resolved', [
        text('redeemed '),
        value(`${amount ?? '—'} USDC`),
        text(' from '),
        market,
        text('.'),
      ]);
  }
}

function graduationKey(event: ActivityEvent) {
  return `${event.txHash.toLowerCase()}:${event.marketId ?? 'protocol'}`;
}

function resolutionPresentationKey(event: ActivityEvent) {
  return `${event.type.toLowerCase()}:${event.txHash.toLowerCase()}:${
    event.marketId?.toLowerCase() ?? 'protocol'
  }`;
}

/**
 * A graduation transaction emits one transition plus two per-outcome book seed
 * logs. Prefer the semantic transition; if only seed logs exist, retain one.
 */
export function dedupeActivityEvents(
  events: readonly ActivityEvent[],
): ActivityEvent[] {
  const graduationTransactions = new Set(
    events
      .filter((event) => event.type === 'MarketGraduated')
      .map(graduationKey),
  );
  const seenIds = new Set<string>();
  const seenGraduations = new Set<string>();
  const seenBookSeeds = new Set<string>();
  const seenResolutionEvents = new Set<string>();

  return events.filter((event) => {
    if (seenIds.has(event.id)) return false;
    seenIds.add(event.id);

    if (event.type === 'ResolutionObserved' || event.type === 'Closeout') {
      const resolutionKey = resolutionPresentationKey(event);
      if (seenResolutionEvents.has(resolutionKey)) return false;
      seenResolutionEvents.add(resolutionKey);
    }

    const key = graduationKey(event);
    if (event.type === 'MarketGraduated') {
      if (seenGraduations.has(key)) return false;
      seenGraduations.add(key);
    }
    if (event.type === 'BookSeeded') {
      if (graduationTransactions.has(key) || seenBookSeeds.has(key)) {
        return false;
      }
      seenBookSeeds.add(key);
    }
    return true;
  });
}
