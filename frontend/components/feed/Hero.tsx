import type { Market } from '@predex-pump/shared/domain';
import Link from 'next/link';

import { HatchingChick } from '@/components/mascot/HatchingChick';
import { buttonClassName } from '@/components/ui/Button';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { formatUsd } from '@/lib/format';

import styles from './Hero.module.css';

function lowerBound(value: string | number, hasMore: boolean) {
  return hasMore ? `${value}+` : value;
}

export function Hero({
  markets,
  hasMore = false,
}: {
  markets: Market[] | null;
  hasMore?: boolean;
}) {
  const graduated =
    markets?.filter((market) => market.graduatedAt !== null).length ?? null;
  const volumeRaw =
    markets === null
      ? null
      : markets
          .reduce((total, market) => total + BigInt(market.volumeRaw), 0n)
          .toString();

  return (
    <section className={styles.hero}>
      <div className={styles.copy}>
        <p className={styles.eyebrow}>
          <span aria-hidden="true" />
          Permissionless market incubator
        </p>
        <h1>Launch a market for any question.</h1>
        <p className={styles.subtitle}>
          Seed it from zero, trade it instantly on a bonding curve, and watch it graduate into an
          order book.
        </p>
        <div className={styles.actions}>
          <Link className={buttonClassName('coral', 'large')} href="/create">
            Launch a market
            <span aria-hidden="true">→</span>
          </Link>
          <a className={buttonClassName('neutral', 'large')} href="#how-it-works">
            How it works
          </a>
        </div>
        <ul className={styles.stats} aria-label="Platform statistics">
          <li>
            <NumberDisplay size="hero">
              {markets === null ? '—' : lowerBound(markets.length, hasMore)}
            </NumberDisplay>
            markets
          </li>
          <li>
            <NumberDisplay size="hero" tone="yes">
              {graduated === null ? '—' : lowerBound(graduated, hasMore)}
            </NumberDisplay>
            graduated
          </li>
          <li>
            <NumberDisplay size="hero" tone="no">
              {volumeRaw === null
                ? '—'
                : lowerBound(formatUsd(volumeRaw, 2), hasMore)}
            </NumberDisplay>
            volume
          </li>
        </ul>
      </div>
      <div className={styles.art} aria-hidden="true">
        <HatchingChick decorative />
      </div>
    </section>
  );
}
