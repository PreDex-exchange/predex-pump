import type { Market, MarketPhase, Raw } from '@predex-pump/shared/domain';

const RAW_DECIMALS = 6;

interface RawFormatOptions {
  decimals?: number;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  useGrouping?: boolean;
}

export function formatRaw(
  raw: Raw,
  {
    decimals = RAW_DECIMALS,
    minimumFractionDigits = 2,
    maximumFractionDigits = 2,
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
    useGrouping: false,
  });
}

export function formatImpliedPercent(raw: Raw, digits = 0) {
  return formatRaw(raw, {
    decimals: 4,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
}

export function formatUsdc(raw: Raw, digits = 2) {
  return formatRaw(raw, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatCompactUsdc(raw: Raw) {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return '—';
  }
  const wholeUsdc = (value + 500_000n) / 1_000_000n;
  return new Intl.NumberFormat('en-US', {
    notation: wholeUsdc >= 10_000n ? 'compact' : 'standard',
    minimumFractionDigits: 0,
    maximumFractionDigits: wholeUsdc >= 10_000n ? 1 : 0,
  }).format(wholeUsdc);
}

export function shortAddress(address: string, leading = 4, trailing = 3) {
  if (address.length <= leading + trailing + 2) return address;
  return `${address.slice(0, leading + 2)}…${address.slice(-trailing)}`;
}

export function phaseLabel(phase: MarketPhase) {
  const labels: Record<MarketPhase, string> = {
    Opened: 'Incubating',
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
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp * 1000);
}
