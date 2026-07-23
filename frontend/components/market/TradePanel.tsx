'use client';

import type { Market, Outcome, Position } from '@predex-pump/shared/domain';
import { useMemo, useState } from 'react';
import { parseUnits } from 'viem';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { Tabs } from '@/components/ui/Tabs';
import { formatPrice, formatRaw, formatUsdc } from '@/lib/format';
import { useQuote } from '@/lib/chain/useQuote';

import styles from './TradePanel.module.css';

type TradeMode = 'buy' | 'sell';

function inputToRaw(value: string) {
  try {
    return parseUnits(value || '0', 6).toString();
  } catch {
    return '0';
  }
}

function positionMetrics(position: Position | undefined, market: Market) {
  if (!position || BigInt(position.qtyRaw) === 0n) return null;
  const quantity = BigInt(position.qtyRaw);
  const averagePriceRaw = (BigInt(position.costBasisRaw) * 1_000_000n) / quantity;
  const priceRaw = position.outcome === 'YES' ? market.yesPriceRaw : market.noPriceRaw;
  const valueRaw = (quantity * BigInt(priceRaw)) / 1_000_000n;

  return {
    averagePriceRaw: averagePriceRaw.toString(),
    valueRaw: valueRaw.toString(),
  };
}

interface TradePanelProps {
  market: Market;
  position?: Position;
  walletConnected: boolean;
}

export function TradePanel({ market, position, walletConnected }: TradePanelProps) {
  const [mode, setMode] = useState<TradeMode>('buy');
  const [outcome, setOutcome] = useState<Outcome>('YES');
  const [amount, setAmount] = useState('25.00');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const amountRaw = inputToRaw(amount);
  const selectedPriceRaw = outcome === 'YES' ? market.yesPriceRaw : market.noPriceRaw;
  const { quote } = useQuote({
    marketId: market.id,
    mode,
    outcome,
    amountRaw,
    priceRaw: selectedPriceRaw,
  });
  const metrics = useMemo(() => positionMetrics(position, market), [market, position]);

  const addAmount = (delta: number) => {
    const current = Number(amount);
    setAmount((Number.isFinite(current) ? current + delta : delta).toFixed(2));
  };

  return (
    <aside className={styles.sticky}>
      <Card className={styles.panel}>
        <Tabs
          ariaLabel="Trade direction"
          onChange={setMode}
          options={[
            { value: 'buy', label: 'Buy' },
            { value: 'sell', label: 'Sell' },
          ]}
          value={mode}
        />

        <div className={styles.sides}>
          {(['YES', 'NO'] as const).map((side) => (
            <button
              aria-pressed={outcome === side}
              className={`${styles.side} ${styles[side.toLowerCase()]} ${
                outcome === side ? styles.selected : ''
              }`}
              key={side}
              onClick={() => setOutcome(side)}
              type="button"
            >
              <span>{side}</span>
              <NumberDisplay size="hero">
                {formatPrice(side === 'YES' ? market.yesPriceRaw : market.noPriceRaw)}
              </NumberDisplay>
            </button>
          ))}
        </div>

        <label className={styles.field}>
          <span>{mode === 'buy' ? 'Amount' : 'Shares to sell'}</span>
          <span className={styles.input}>
            <input
              inputMode="decimal"
              onChange={(event) => setAmount(event.target.value)}
              value={amount}
            />
            <span>{mode === 'buy' ? 'USDC' : outcome}</span>
          </span>
        </label>
        <div className={styles.chips}>
          {[10, 50, 100].map((delta) => (
            <button key={delta} onClick={() => addAmount(delta)} type="button">
              +{delta}
            </button>
          ))}
          <button onClick={() => setAmount(mode === 'buy' ? '250.00' : '48.00')} type="button">
            Max
          </button>
        </div>

        <div className={styles.quote}>
          <div>
            <span>Avg price</span>
            <strong className="numeric">{formatPrice(quote.avgPriceRaw, 3)}</strong>
          </div>
          {mode === 'buy' && (
            <div>
              <span>Shares ({outcome})</span>
              <strong className="numeric">
                {formatRaw(quote.sharesRaw, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </strong>
            </div>
          )}
          <div>
            <span>Protocol fee</span>
            <strong className="numeric">{formatUsdc(quote.feeRaw)} USDC</strong>
          </div>
          <div>
            <span>{mode === 'buy' ? 'Max cost (0.5% slip)' : 'Min receive (0.5% slip)'}</span>
            <strong className="numeric">{formatUsdc(quote.maxOrMinRaw)} USDC</strong>
          </div>
          <div className={styles.total}>
            <span>{mode === 'buy' ? 'You pay' : 'You receive'}</span>
            <strong className="numeric">{formatUsdc(quote.totalRaw)} USDC</strong>
          </div>
        </div>

        <Button
          fullWidth
          onClick={() => setConfirmOpen(true)}
          size="large"
          variant={outcome === 'YES' ? 'mint' : 'sky'}
        >
          {walletConnected ? `${mode === 'buy' ? 'Buy' : 'Sell'} ${outcome}` : `Preview ${mode} ${outcome}`}
        </Button>
        <p className={styles.reassure}>
          {walletConnected
            ? 'Settles on-chain in USDC · non-custodial'
            : 'Connect in the top bar when live writes arrive'}
        </p>

        <div className={styles.position}>
          <h2>{walletConnected ? 'Your position' : 'Demo position'}</h2>
          {position && metrics ? (
            <>
              <div>
                <span>{position.outcome} held</span>
                <strong className="numeric">
                  {formatRaw(position.qtyRaw, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </strong>
              </div>
              <div>
                <span>Avg cost</span>
                <strong className="numeric">{formatPrice(metrics.averagePriceRaw, 3)}</strong>
              </div>
              <div>
                <span>Value</span>
                <strong className="numeric">{formatUsdc(metrics.valueRaw)} USDC</strong>
              </div>
              <div>
                <span>
                  PnL <small>(est.)</small>
                </span>
                <strong className={`${styles.gain} numeric`}>
                  +{formatUsdc(position.unrealizedPnlRaw)} USDC
                </strong>
              </div>
            </>
          ) : (
            <p className={styles.noPosition}>No position in this market yet.</p>
          )}
        </div>
      </Card>

      <ConfirmModal
        confirmLabel="Keep previewing"
        onClose={() => setConfirmOpen(false)}
        onConfirm={() =>
          console.info('Phase C1 trade stub', {
            marketId: market.id,
            mode,
            outcome,
            amountRaw,
          })
        }
        open={confirmOpen}
        title={`${mode === 'buy' ? 'Buy' : 'Sell'} ${outcome} preview`}
      >
        <p>
          This quote is contract-shaped mock data. Phase C1 does not send a wallet request or write
          to Arc.
        </p>
      </ConfirmModal>
    </aside>
  );
}
