import type { Market } from '@predex-pump/shared/domain';
import Link from 'next/link';

import { HatchingChick } from '@/components/mascot/HatchingChick';
import { buttonClassName } from '@/components/ui/Button';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { formatUsdc } from '@/lib/format';

import styles from './Hero.module.css';

export function Hero({ markets }: { markets: Market[] }) {
  const graduated = markets.filter(
    (market) => market.phase !== 'Opened',
  ).length;
  const volumeRaw = markets
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
            <NumberDisplay size="hero">{markets.length}</NumberDisplay>
            markets
          </li>
          <li>
            <NumberDisplay size="hero" tone="yes">
              {graduated}
            </NumberDisplay>
            graduated
          </li>
          <li>
            <NumberDisplay size="hero" tone="no">
              ${formatUsdc(volumeRaw, 0)}
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
