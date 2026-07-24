'use client';

import type { Market, Resolution } from '@predex-pump/shared/domain';

import { HatchingChick } from '@/components/mascot/HatchingChick';
import { OutcomeBadge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { formatRaw } from '@/lib/format';

import styles from './PhasePanels.module.css';

export function HatchedHeader({ market }: { market: Market }) {
  return (
    <section className={styles.hatched}>
      <HatchingChick decorative />
      <div>
        <span className={styles.kicker}>The market hatched</span>
        <h2>Order book now live</h2>
        <p>
          The bonding curve handed off{' '}
          <strong className="numeric">{formatRaw(market.handoffSizeRaw ?? '0')} complete sets</strong>{' '}
          into a transparent order book.
        </p>
      </div>
      <span className={styles.live}>
        <span aria-hidden="true" />
        Trading
      </span>
    </section>
  );
}

export function ResolvedOutcomePanel({
  market,
  resolution,
}: {
  market: Market;
  resolution: Resolution | null;
}) {
  const outcome = resolution?.outcome ?? (market.yesPriceRaw === '1000000' ? 'YES' : 'NO');

  return (
    <Card className={styles.resolvedCard}>
      <span className={styles.settledKicker}>Final outcome</span>
      <div className={styles.resolvedHeading}>
        {outcome === 'INVALID' ? (
          <span className={styles.invalid}>Invalid · split payout</span>
        ) : (
          <OutcomeBadge outcome={outcome} />
        )}
        <NumberDisplay size="price">
          {outcome === 'INVALID' ? '0.50 / 0.50' : '1.00'}
        </NumberDisplay>
      </div>
      <h2>{market.question}</h2>
      <p>
        The committee outcome has been observed on-chain. Prices are final and eligible positions
        can be redeemed from Conditional Tokens.
      </p>
      <div className={styles.resolutionMeta}>
        <span>Condition</span>
        <code className="mono">{market.conditionId.slice(0, 12)}…{market.conditionId.slice(-6)}</code>
      </div>
    </Card>
  );
}
