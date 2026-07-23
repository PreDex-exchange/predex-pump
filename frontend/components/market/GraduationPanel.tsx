import type { Market } from '@predex-pump/shared/domain';

import { CrackingEgg } from '@/components/mascot/HatchingChick';
import { Card } from '@/components/ui/Card';
import {
  formatUsdc,
  graduationPercent,
} from '@/lib/format';

import styles from './GraduationPanel.module.css';

export function GraduationPanel({ market }: { market: Market }) {
  const progress = graduationPercent(market);

  return (
    <Card className={styles.card}>
      <div className={styles.eggWrap}>
        <CrackingEgg progress={progress} />
      </div>
      <div className={styles.body}>
        <h2>This market is incubating</h2>
        <p>
          It trades on a bonding curve now. At 100% it hatches into an order book — a one-time{' '}
          <strong className="numeric">{formatUsdc(market.params.graduationTollRaw)} USDC</strong>{' '}
          toll graduates it.
        </p>
        <div
          aria-label={`${progress}% to graduation`}
          className={styles.bar}
          role="progressbar"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className={styles.row}>
          <strong className="numeric">{progress}% to graduation</strong>
          <span className="numeric">
            ${formatUsdc(market.graduationActivityRaw, 0)} of $
            {formatUsdc(market.params.graduationMoneyInThresholdRaw, 0)} non-creator volume
          </span>
        </div>
      </div>
    </Card>
  );
}
