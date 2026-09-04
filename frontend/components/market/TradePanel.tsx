'use client';

import type { Market, Outcome, Position } from '@predex-pump/shared/domain';
import { isOrderSizeGranular } from '@predex-pump/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits, parseUnits } from 'viem';
import { useAccount } from 'wagmi';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { Tabs } from '@/components/ui/Tabs';
import { TxStatus } from '@/components/ui/TxStatus';
import { arcTestnet } from '@/lib/chain/arc';
import { buyOnArc, sellOnArc } from '@/lib/chain/transactions';
import { useQuote } from '@/lib/chain/useQuote';
import { useTxFlow } from '@/lib/chain/useTxFlow';
import {
  formatPrice,
  formatShareQuantity,
  formatUsdc,
} from '@/lib/format';
import {
  ORDER_SIZE_STEP,
  ORDER_SIZE_STEP_ERROR,
  snappedOrderSizeInput,
} from '@/lib/order-input';
import { positionCurrentValueRaw } from '@/lib/market-state';

import styles from './TradePanel.module.css';

type TradeMode = 'buy' | 'sell';

function inputToRaw(value: string) {
  try {
    return parseUnits(value || '0', 6).toString();
  } catch {
    return '0';
  }
}

interface TradePanelProps {
  market: Market;
  positions?: Position[];
}

export function TradePanel({ market, positions = [] }: TradePanelProps) {
  const [mode, setMode] = useState<TradeMode>('buy');
  const [outcome, setOutcome] = useState<Outcome>('YES');
  const [amount, setAmount] = useState('0.10');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobilePanelRef = useRef<HTMLDivElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const sheetStateRef = useRef({ confirmOpen: false, txBusy: false });
  const { address, chainId, isConnected } = useAccount();
  const tx = useTxFlow();
  const amountRaw = inputToRaw(amount);
  const amountValue = BigInt(amountRaw);
  const amountIsGranular = isOrderSizeGranular(amountValue);
  const sizeError =
    amountValue <= 0n
      ? 'Enter a trade size greater than zero'
      : !amountIsGranular
        ? ORDER_SIZE_STEP_ERROR
        : null;
  const selectedPosition = positions.find(
    (position) => position.outcome === outcome,
  );
  const positionValueRaw = useMemo(
    () =>
      selectedPosition
        ? positionCurrentValueRaw(selectedPosition, market)
        : null,
    [market, selectedPosition],
  );
  const {
    quote,
    isLoading: quoteLoading,
    error: quoteError,
    refetch: refetchQuote,
  } = useQuote({
    marketId: market.id,
    mode,
    outcome,
    amountRaw,
  });
  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;
  const insufficientTokens =
    mode === 'sell' &&
    (!selectedPosition || BigInt(selectedPosition.qtyRaw) < amountValue);
  const canTrade =
    market.phase === 'Opened' &&
    isConnected &&
    Boolean(address) &&
    !isWrongNetwork &&
    amountIsGranular &&
    Boolean(quote) &&
    !quoteError &&
    !insufficientTokens;

  const addAmount = (delta: number) => {
    const current = Number(amount);
    setAmount((Number.isFinite(current) ? current + delta : delta).toFixed(2));
  };

  async function handleTrade() {
    if (!address || !canTrade) return;
    const result =
      mode === 'buy'
        ? await tx.execute((report) =>
            buyOnArc({
              account: address,
              marketId: BigInt(market.id),
              outcome,
              amountRaw: amountValue,
              report,
            }),
          )
        : await tx.execute((report) =>
            sellOnArc({
              account: address,
              marketId: BigInt(market.id),
              outcome,
              amountRaw: amountValue,
              report,
            }),
          );
    if (!result) return;

    // Display state lands through the backend WebSocket after indexing. The
    // next signing quote remains a fresh chain read.
    void refetchQuote();
  }

  function closeConfirm() {
    if (tx.isBusy) return;
    setConfirmOpen(false);
    tx.reset();
  }

  const actionLabel = `${mode === 'buy' ? 'Buy' : 'Sell'} ${outcome}`;
  const buttonLabel = !isConnected
    ? 'Connect wallet in the header'
    : isWrongNetwork
      ? 'Switch to Arc Testnet'
      : sizeError
        ? sizeError
        : insufficientTokens
        ? `Insufficient ${outcome} tokens`
        : quoteLoading
          ? 'Reading live quote…'
          : actionLabel;

  function closeMobileTrade() {
    if (tx.isBusy || confirmOpen) return;
    setMobileOpen(false);
  }

  useEffect(() => {
    sheetStateRef.current = { confirmOpen, txBusy: tx.isBusy };
  }, [confirmOpen, tx.isBusy]);

  useEffect(() => {
    if (!mobileOpen) return;

    const panel = mobilePanelRef.current;
    const trigger = mobileTriggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !sheetStateRef.current.confirmOpen &&
        !sheetStateRef.current.txBusy
      ) {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (
        event.key !== 'Tab' ||
        panel === null ||
        sheetStateRef.current.confirmOpen
      ) {
        return;
      }

      const focusable = [
        ...panel.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [mobileOpen]);

  return (
    <aside
      className={`${styles.sticky} ${mobileOpen ? styles.mobileOpen : ''}`}
    >
      <div className={styles.mobileDock}>
        <div className={styles.dockPrices}>
          <strong>Trade this market</strong>
          <span className="numeric">
            YES {formatPrice(market.yesPriceRaw, 6)} · NO{' '}
            {formatPrice(market.noPriceRaw, 6)}
          </span>
        </div>
        <button
          aria-controls="curve-trade-mobile-sheet"
          aria-expanded={mobileOpen}
          className={styles.dockButton}
          onClick={() => setMobileOpen(true)}
          ref={mobileTriggerRef}
          type="button"
        >
          Trade
        </button>
      </div>

      <button
        aria-hidden="true"
        className={styles.mobileBackdrop}
        onClick={closeMobileTrade}
        tabIndex={-1}
        type="button"
      />

      <div
        aria-labelledby={mobileOpen ? 'curve-trade-mobile-title' : undefined}
        aria-modal={mobileOpen ? 'true' : undefined}
        className={styles.ticketFrame}
        id="curve-trade-mobile-sheet"
        ref={mobilePanelRef}
        role={mobileOpen ? 'dialog' : undefined}
        tabIndex={-1}
      >
        <div className={styles.sheetChrome}>
          <span aria-hidden="true" className={styles.sheetGrabber} />
          <strong id="curve-trade-mobile-title">Trade</strong>
          <button
            aria-label="Close trade ticket"
            className={styles.sheetClose}
            disabled={tx.isBusy || confirmOpen}
            onClick={closeMobileTrade}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m7 7 10 10M17 7 7 17" />
            </svg>
          </button>
        </div>

        <Card className={styles.panel}>
        <Tabs
          ariaLabel="Trade direction"
          onChange={(value) => {
            setMode(value);
            tx.reset();
          }}
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
              onClick={() => {
                setOutcome(side);
                tx.reset();
              }}
              type="button"
            >
              <span>{side}</span>
              <NumberDisplay size="hero">
                {formatPrice(
                  side === 'YES' ? market.yesPriceRaw : market.noPriceRaw,
                  6,
                )}
              </NumberDisplay>
            </button>
          ))}
        </div>

        <label className={styles.field}>
          <span>{mode === 'buy' ? 'Shares to buy' : 'Shares to sell'}</span>
          <span className={styles.input}>
            <input
              aria-describedby={sizeError ? 'curve-trade-size-error' : undefined}
              aria-invalid={sizeError !== null}
              inputMode="decimal"
              onChange={(event) => setAmount(event.target.value)}
              onBlur={() => {
                if (amountValue > 0n && !amountIsGranular) {
                  setAmount(snappedOrderSizeInput(amountValue));
                }
              }}
              step={ORDER_SIZE_STEP}
              value={amount}
            />
            <span>{outcome}</span>
          </span>
        </label>
        {sizeError && (
          <p
            className={styles.sizeError}
            id="curve-trade-size-error"
            role="alert"
          >
            {sizeError}
          </p>
        )}
        <div className={styles.chips}>
          {[0.1, 0.5, 1].map((delta) => (
            <button key={delta} onClick={() => addAmount(delta)} type="button">
              +{delta}
            </button>
          ))}
          <button
            disabled={mode === 'sell' && !selectedPosition}
            onClick={() =>
              setAmount(
                mode === 'sell' && selectedPosition
                  ? formatUnits(BigInt(selectedPosition.qtyRaw), 6)
                  : '5.00',
              )
            }
            type="button"
          >
            Max
          </button>
        </div>

        <div className={styles.quote}>
          <div>
            <span>Avg curve price</span>
            <strong className="numeric">
              {quote ? formatPrice(quote.avgPriceRaw, 6) : '—'}
            </strong>
          </div>
          <div>
            <span>Shares ({outcome})</span>
            <strong className="numeric">
              {quote
                ? formatShareQuantity(quote.sharesRaw, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })
                : '—'}
            </strong>
          </div>
          <div>
            <span>Trade fees</span>
            <strong className="numeric">
              {quote ? `${formatUsdc(quote.feeRaw, 6)} USDC` : '—'}
            </strong>
          </div>
          <div>
            <span>
              {mode === 'buy'
                ? 'Max cost (0.5% slip)'
                : 'Min receive (0.5% slip)'}
            </span>
            <strong className="numeric">
              {quote ? `${formatUsdc(quote.maxOrMinRaw, 6)} USDC` : '—'}
            </strong>
          </div>
          <div className={styles.total}>
            <span>{mode === 'buy' ? 'Quoted cost' : 'Quoted proceeds'}</span>
            <strong className="numeric">
              {quote ? `${formatUsdc(quote.totalRaw, 6)} USDC` : '—'}
            </strong>
          </div>
          {quoteError && (
            <p className={styles.quoteError} role="alert">
              The live quote could not be read from Arc. Try again.
            </p>
          )}
        </div>

        <Button
          disabled={!canTrade || quoteLoading}
          fullWidth
          onClick={() => setConfirmOpen(true)}
          size="large"
          variant={outcome === 'YES' ? 'mint' : 'sky'}
        >
          {buttonLabel}
        </Button>
        <p className={styles.reassure}>
          Size step 0.001 token · sub-step positive sizes stay visible · larger
          off-step sizes round down on blur · future book price tick{' '}
          {formatUnits(BigInt(market.params.minimumTickSizeRaw), 6)} USDC
        </p>

        <div className={styles.position}>
          <h2>Your live {outcome} position</h2>
          {selectedPosition ? (
            <>
              <div>
                <span>{outcome} held</span>
                <strong className="numeric">
                  {formatShareQuantity(selectedPosition.qtyRaw, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </strong>
              </div>
              <div>
                <span>Reference value</span>
                <strong className="numeric">
                  {formatUsdc(positionValueRaw ?? '0')} USDC
                </strong>
              </div>
              <p className={styles.noPosition}>
                Quantity is indexed from CTF transfers. Reference value uses the
                indexed market price and is not guaranteed sale proceeds.
              </p>
            </>
          ) : (
            <p className={styles.noPosition}>No {outcome} tokens held by this wallet.</p>
          )}
        </div>
        </Card>
      </div>

      <ConfirmModal
        closeDisabled={tx.isBusy}
        closeOnConfirm={false}
        confirmDisabled={tx.isBusy || tx.state.phase === 'confirmed'}
        confirmLabel={
          tx.state.phase === 'reverted'
            ? `Retry ${actionLabel}`
            : tx.state.phase === 'confirmed'
              ? 'Confirmed'
              : `Approve & ${actionLabel}`
        }
        kicker="Live Arc transaction"
        onClose={closeConfirm}
        onConfirm={handleTrade}
        open={confirmOpen}
        title={actionLabel}
      >
        <p>
          The LMSR quote, lifecycle, balance, and approval are refreshed immediately before
          signing. The final call uses a 0.5% slippage bound and a deadline derived from the latest
          Arc block.
        </p>
        <dl className={styles.confirmRows}>
          <div>
            <dt>Shares</dt>
            <dd className="numeric">
              {formatShareQuantity(amountRaw)} {outcome}
            </dd>
          </div>
          <div>
            <dt>{mode === 'buy' ? 'Current max cost' : 'Current min receive'}</dt>
            <dd className="numeric">
              {quote ? formatUsdc(quote.maxOrMinRaw, 6) : '—'} USDC
            </dd>
          </div>
          <div>
            <dt>Approval</dt>
            <dd>{mode === 'buy' ? 'USDC → LMSR if needed' : 'CTF → LMSR if needed'}</dd>
          </div>
        </dl>
        <TxStatus state={tx.state} />
      </ConfirmModal>
    </aside>
  );
}
