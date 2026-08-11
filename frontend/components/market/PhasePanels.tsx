'use client';

import type { Market, Resolution } from '@predex-pump/shared/domain';

import { OutcomeBadge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { formatRaw } from '@/lib/format';
import { indexedResolution, resolvedOutcome } from '@/lib/market-state';

import styles from './PhasePanels.module.css';

export function HatchedHeader({ market }: { market: Market }) {
  return (
    <section className={styles.hatched}>
      <div>
        <span className={styles.kicker}>The market graduated</span>
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
  const finalResolution = indexedResolution(market, resolution);
  const outcome = resolvedOutcome(market, resolution);
  const settledWithoutGraduation = market.graduatedAt === null;
  const observed =
    market.phase === 'ResolvedObserved' ||
    market.phase === 'ClosedOut' ||
    (finalResolution?.observedAt !== null &&
      finalResolution?.observedAt !== undefined);

  return (
    <Card className={styles.resolvedCard}>
      <span className={styles.settledKicker}>Final outcome</span>
      <div className={styles.resolvedHeading}>
        {outcome === 'INVALID' ? (
          <span className={styles.invalid}>Invalid · split payout</span>
        ) : outcome ? (
          <OutcomeBadge outcome={outcome} />
        ) : (
          <span className={styles.invalid}>Resolved</span>
        )}
        <NumberDisplay size="price">
          {outcome === 'INVALID'
            ? '0.50 / 0.50'
            : outcome
              ? '1.00'
              : 'Final'}
        </NumberDisplay>
      </div>
      <h2>{market.question}</h2>
      <p>
        {observed && settledWithoutGraduation
          ? 'The committee outcome was observed directly from incubation, without graduation. Curve trading is stopped, prices are final, and eligible positions can be redeemed from Conditional Tokens.'
          : observed
            ? 'The committee outcome has been observed by the incubator. Prices are final and eligible positions can be redeemed from Conditional Tokens.'
            : 'The final payout is recorded in Conditional Tokens, so trading is stopped and eligible positions can be redeemed. The incubator lifecycle can still be advanced by observing the resolution.'}
      </p>
      <div className={styles.resolutionMeta}>
        <span>Condition</span>
        <code className="mono">{market.conditionId.slice(0, 12)}…{market.conditionId.slice(-6)}</code>
      </div>
    </Card>
  );
}
