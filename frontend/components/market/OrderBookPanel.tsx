'use client';

import type { OrderBook, Outcome } from '@predex-pump/shared/domain';
import type { MarketBookResponse } from '@predex-pump/shared/rest';
import { useState } from 'react';

import { Card } from '@/components/ui/Card';
import { Tabs } from '@/components/ui/Tabs';
import { formatPrice, formatRaw, formatUsdc } from '@/lib/format';

import styles from './OrderBookPanel.module.css';

function Ladder({
  book,
  side,
}: {
  book: OrderBook;
  side: 'asks' | 'bids';
}) {
  const levels = book[side];

  if (levels.length === 0) {
    return <div className={styles.empty}>No {side} in this preview yet.</div>;
  }

  return (
    <div className={styles.levels}>
      {levels.map((level) => {
        const totalRaw = (
          (BigInt(level.priceRaw) * BigInt(level.sizeRaw)) /
          1_000_000n
        ).toString();
        return (
          <div className={styles.level} key={`${side}:${level.priceRaw}`}>
            <span className="numeric">{formatPrice(level.priceRaw, 3)}</span>
            <span className="numeric">
              {formatRaw(level.sizeRaw, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 2,
              })}
            </span>
            <span className="numeric">{formatUsdc(totalRaw)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function OrderBookPanel({ books }: { books: MarketBookResponse }) {
  const [outcome, setOutcome] = useState<Outcome>('YES');
  const book = outcome === 'YES' ? books.yes : books.no;

  return (
    <Card className={styles.card}>
      <div className={styles.header}>
        <div>
          <h2>Order book</h2>
          <p>Graduated market · mock ladder</p>
        </div>
        <Tabs
          ariaLabel="Order book outcome"
          compact
          onChange={setOutcome}
          options={[
            { value: 'YES', label: 'YES' },
            { value: 'NO', label: 'NO' },
          ]}
          value={outcome}
        />
      </div>
      <div className={styles.columns}>
        <span>Price</span>
        <span>Size</span>
        <span>Total USDC</span>
      </div>
      <div className={`${styles.section} ${styles.asks}`}>
        <span className={styles.sectionLabel}>Asks</span>
        <Ladder book={book} side="asks" />
      </div>
      <div className={styles.spread}>
        <span>Spread</span>
        <strong className="numeric">
          {book.asks[0] && book.bids[0]
            ? formatPrice(
                (BigInt(book.asks[0].priceRaw) - BigInt(book.bids[0].priceRaw)).toString(),
                3,
              )
            : '—'}
        </strong>
      </div>
      <div className={`${styles.section} ${styles.bids}`}>
        <span className={styles.sectionLabel}>Bids</span>
        <Ladder book={book} side="bids" />
      </div>
    </Card>
  );
}
