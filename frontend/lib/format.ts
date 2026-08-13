import type { Market, MarketPhase, Raw } from '@predex-pump/shared/domain';

const RAW_DECIMALS = 6;

interface RawFormatOptions {
  decimals?: number;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  nonZeroFloor?: boolean;
  useGrouping?: boolean;
}

function smallestDisplayedMagnitude(maximumFractionDigits: number) {
  if (maximumFractionDigits === 0) return '1';
  return `0.${'0'.repeat(maximumFractionDigits - 1)}1`;
}

export function formatRaw(
  raw: Raw,
  {
    decimals = RAW_DECIMALS,
    minimumFractionDigits = 2,
    maximumFractionDigits = 2,
    nonZeroFloor = false,
    useGrouping = true,
  }: RawFormatOptions = {},
) {
  let value: bigint;

  try {
    value = BigInt(raw);
  } catch {
    return '—';
  }

  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const precisionScale = 10n ** BigInt(maximumFractionDigits);
  const rounded = (absolute * precisionScale + scale / 2n) / scale;

  if (nonZeroFloor && absolute > 0n && rounded === 0n) {
    const threshold = smallestDisplayedMagnitude(maximumFractionDigits);
    return negative ? `>−${threshold}` : `<${threshold}`;
  }

  const whole = rounded / precisionScale;
  let fraction = (rounded % precisionScale).toString().padStart(maximumFractionDigits, '0');

  while (fraction.length > minimumFractionDigits && fraction.endsWith('0')) {
    fraction = fraction.slice(0, -1);
  }

  const wholeFormatted = useGrouping
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(whole)
    : whole.toString();

  return `${negative ? '−' : ''}${wholeFormatted}${fraction ? `.${fraction}` : ''}`;
}

export function formatPrice(raw: Raw, digits = 2) {
  return formatRaw(raw, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    nonZeroFloor: true,
    useGrouping: false,
  });
}

export function formatImpliedPercent(raw: Raw, digits = 0) {
  return formatRaw(raw, {
    decimals: 4,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    nonZeroFloor: true,
    useGrouping: false,
  });
}

export function formatShareQuantity(
  raw: Raw,
  {
    minimumFractionDigits = 2,
    maximumFractionDigits = 2,
  }: Pick<
    RawFormatOptions,
    'minimumFractionDigits' | 'maximumFractionDigits'
  > = {},
) {
  return formatRaw(raw, {
    minimumFractionDigits,
    maximumFractionDigits,
    nonZeroFloor: true,
  });
}

export function formatUsdc(raw: Raw, digits = 2) {
  return formatRaw(raw, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    nonZeroFloor: true,
  });
}

export function formatUsd(raw: Raw, digits = 2) {
  const formatted = formatUsdc(raw, digits);
  if (formatted === '—') return formatted;
  if (formatted.startsWith('<')) return `<$${formatted.slice(1)}`;
  if (formatted.startsWith('>−')) return `>−$${formatted.slice(2)}`;
  if (formatted.startsWith('−')) return `−$${formatted.slice(1)}`;
  return `$${formatted}`;
}

export function formatSignedUsdc(raw: Raw, digits = 2) {
  const formatted = formatUsdc(raw, digits);

  try {
    return BigInt(raw) > 0n ? `+${formatted}` : formatted;
  } catch {
    return formatted;
  }
}

export type UsdcInputFailure =
  | 'EMPTY'
  | 'NEGATIVE'
  | 'NON_NUMERIC'
  | 'INVALID_FORMAT'
  | 'TOO_MANY_DECIMALS';

export type UsdcInputParseResult =
  | { ok: true; raw: Raw }
  | { ok: false; reason: UsdcInputFailure };

export function parseUsdcInputResult(value: string): UsdcInputParseResult {
  const normalized = value.trim();
  if (normalized === '') return { ok: false, reason: 'EMPTY' };
  if (normalized.startsWith('-')) return { ok: false, reason: 'NEGATIVE' };
  if (/[^\d.]/u.test(normalized)) {
    return { ok: false, reason: 'NON_NUMERIC' };
  }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(normalized)) {
    return { ok: false, reason: 'INVALID_FORMAT' };
  }

  const [whole = '0', fraction = ''] = normalized.split('.');
  if (fraction.length > RAW_DECIMALS) {
    return { ok: false, reason: 'TOO_MANY_DECIMALS' };
  }

  try {
    return {
      ok: true,
      raw: (
        BigInt(whole || '0') * 1_000_000n +
        BigInt(fraction.padEnd(6, '0') || '0')
      ).toString(),
    };
  } catch {
    return { ok: false, reason: 'INVALID_FORMAT' };
  }
}

export function parseUsdcInput(value: string): Raw | null {
  const result = parseUsdcInputResult(value);
  return result.ok ? result.raw : null;
}

export function formatCompactUsdc(raw: Raw) {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return '—';
  }
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const wholeUsdc = (absolute + 500_000n) / 1_000_000n;
  if (absolute > 0n && wholeUsdc === 0n) {
    return negative ? '>−1' : '<1';
  }
  const formatted = new Intl.NumberFormat('en-US', {
    notation: wholeUsdc >= 10_000n ? 'compact' : 'standard',
    minimumFractionDigits: 0,
    maximumFractionDigits: wholeUsdc >= 10_000n ? 1 : 0,
  }).format(wholeUsdc);
  return negative ? `−${formatted}` : formatted;
}

export function shortAddress(address: string, leading = 4, trailing = 3) {
  if (address.length <= leading + trailing + 2) return address;
  return `${address.slice(0, leading + 2)}…${address.slice(-trailing)}`;
}

export function phaseLabel(phase: MarketPhase) {
  const labels: Record<MarketPhase, string> = {
    Opened: 'Bootstrap',
    Graduated: 'Graduated',
    ResolvedObserved: 'Resolved',
    ClosedOut: 'Closed out',
  };

  return labels[phase];
}

export function graduationPercent(market: Market) {
  const activity = BigInt(market.graduationActivityRaw);
  const threshold = BigInt(market.params.graduationMoneyInThresholdRaw);
  if (threshold === 0n) return 100;
  return Math.min(100, Number((activity * 100n + threshold / 2n) / threshold));
}

export function relativeTime(timestamp: number, referenceTimestamp = Math.floor(Date.now() / 1000)) {
  const delta = Math.max(0, referenceTimestamp - timestamp);
  if (delta < 60) return 'now';
  if (delta < 3_600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3_600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}

export function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(timestamp * 1000);
}
