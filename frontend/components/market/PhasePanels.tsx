'use client';

import type { Market, Outcome, Position, Resolution } from '@predex-pump/shared/domain';
import { useState } from 'react';

import { HatchingChick } from '@/components/mascot/HatchingChick';
import { OutcomeBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { Tabs } from '@/components/ui/Tabs';
import { formatPrice, formatRaw, formatUsdc } from '@/lib/format';

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

export function BookActionPanel({ market }: { market: Market }) {
  const [outcome, setOutcome] = useState<Outcome>('YES');
  const [orderSide, setOrderSide] = useState<'BID' | 'ASK'>('BID');
  const [open, setOpen] = useState(false);

  return (
    <aside className={styles.actionSticky}>
      <Card>
        <h2 className={styles.actionTitle}>Place an order</h2>
        <Tabs
          ariaLabel="Order side"
          onChange={setOrderSide}
          options={[
            { value: 'BID', label: 'Buy' },
            { value: 'ASK', label: 'Sell' },
          ]}
          value={orderSide}
        />
        <div className={styles.outcomeTabs}>
          {(['YES', 'NO'] as const).map((value) => (
            <button
              className={`${styles.outcomeButton} ${styles[value.toLowerCase()]} ${
                outcome === value ? styles.outcomeSelected : ''
              }`}
              key={value}
              onClick={() => setOutcome(value)}
              type="button"
            >
              <span>{value}</span>
              <NumberDisplay>
                {formatPrice(value === 'YES' ? market.yesPriceRaw : market.noPriceRaw)}
              </NumberDisplay>
            </button>
          ))}
        </div>
        <label className={styles.bookField}>
          Limit price
          <span>
            <input defaultValue={formatPrice(outcome === 'YES' ? market.yesPriceRaw : market.noPriceRaw, 3)} inputMode="decimal" />
            <b>USDC</b>
          </span>
        </label>
        <label className={styles.bookField}>
          Size
          <span>
            <input defaultValue="50.00" inputMode="decimal" />
            <b>{outcome}</b>
          </span>
        </label>
        <div className={styles.orderTotal}>
          <span>Estimated total</span>
          <strong className="numeric">36.50 USDC</strong>
        </div>
        <Button
          fullWidth
          onClick={() => setOpen(true)}
          size="large"
          variant={outcome === 'YES' ? 'mint' : 'sky'}
        >
          Preview order
        </Button>
        <p className={styles.note}>
          Coming soon — MiniCLOB place, fill, and cancel writes are deferred after Phase C3.
        </p>
      </Card>
      <ConfirmModal
        onClose={() => setOpen(false)}
        onConfirm={() =>
          console.info('Deferred MiniCLOB place-order preview', {
            marketId: market.id,
            outcome,
            orderSide,
          })
        }
        open={open}
        title="Order preview"
      >
        <p>
          Coming soon. This preview does not request MiniCLOB approval or submit a place
          transaction.
        </p>
      </ConfirmModal>
    </aside>
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

export function RedeemPanel({
  market,
  position,
}: {
  market: Market;
  position?: Position;
}) {
  const [open, setOpen] = useState(false);
  const closed = market.phase === 'ClosedOut';
  const estimatedPayout =
    position && (position.outcome === 'YES' ? market.yesPriceRaw : market.noPriceRaw) === '1000000'
      ? position.qtyRaw
      : '0';

  return (
    <aside className={styles.actionSticky}>
      <Card>
        <h2 className={styles.actionTitle}>{closed ? 'Market closed out' : 'Redeem position'}</h2>
        <div className={styles.redeemRows}>
          <div>
            <span>Eligible shares</span>
            <strong className="numeric">
              {position
                ? `${formatRaw(position.qtyRaw, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })} ${position.outcome}`
                : '0.00'}
            </strong>
          </div>
          <div>
            <span>Estimated payout</span>
            <strong className="numeric">{formatUsdc(estimatedPayout)} USDC</strong>
          </div>
        </div>
        <Button
          disabled={closed || !position}
          fullWidth
          onClick={() => setOpen(true)}
          size="large"
          variant="mint"
        >
          {closed ? 'Redemption closed' : position ? 'Preview redeem' : 'No position to redeem'}
        </Button>
        <p className={styles.note}>
          {closed
            ? 'This market has completed closeout.'
            : 'Coming soon — committee resolve, redeem, and closeout writes remain deferred.'}
        </p>
      </Card>
      <ConfirmModal
        onClose={() => setOpen(false)}
        onConfirm={() => console.info('Deferred CTF redeem preview', { marketId: market.id })}
        open={open}
        title="Redemption preview"
      >
        <p>
          Coming soon. This preview does not call Conditional Tokens or submit a wallet
          transaction.
        </p>
      </ConfirmModal>
    </aside>
  );
}
