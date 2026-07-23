import type { Trade } from '@predex-pump/shared/domain';

import { Card } from '@/components/ui/Card';
import { formatPrice, formatRaw, relativeTime, shortAddress } from '@/lib/format';

import styles from './RecentTrades.module.css';

export function RecentTrades({ trades }: { trades: Trade[] }) {
  return (
    <Card>
      <h2 className={styles.title}>Recent activity</h2>
      {trades.length === 0 ? (
        <p className={styles.empty}>No trades have landed in this market yet.</p>
      ) : (
        <div>
          {trades.map((trade) => (
            <div className={styles.trade} key={trade.id}>
              <span
                className={`${styles.tag} ${
                  trade.outcome === 'YES' ? styles.yes : styles.no
                }`}
              >
                {trade.side === 'BID' ? 'BUY' : 'SELL'}
              </span>
              <span className={styles.summary}>
                <span className="numeric">
                  {formatRaw(trade.sizeRaw, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2,
                  })}
                </span>{' '}
                {trade.outcome} @ <span className="numeric">{formatPrice(trade.priceRaw)}</span>
              </span>
              <span className={`${styles.account} mono`}>{shortAddress(trade.account)}</span>
              <span className={styles.when}>
                {relativeTime(trade.ts).replace(' ago', '')}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
