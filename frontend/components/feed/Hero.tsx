import Link from 'next/link';

import { HatchingChick } from '@/components/mascot/HatchingChick';
import { buttonClassName } from '@/components/ui/Button';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { formatUsdc } from '@/lib/format';
import { MOCK_FEED_STATS } from '@/lib/mock/data';

import styles from './Hero.module.css';

export function Hero() {
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
            <NumberDisplay size="hero">{MOCK_FEED_STATS.markets}</NumberDisplay>
            markets
          </li>
          <li>
            <NumberDisplay size="hero" tone="yes">
              {MOCK_FEED_STATS.graduated}
            </NumberDisplay>
            graduated
          </li>
          <li>
            <NumberDisplay size="hero" tone="no">
              ${formatUsdc(MOCK_FEED_STATS.volumeRaw, 0)}
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
