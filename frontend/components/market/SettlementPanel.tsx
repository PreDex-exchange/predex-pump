'use client';

import type {
  Market,
  ResolutionOutcome,
} from '@predex-pump/shared/domain';
import { useState } from 'react';
import { useAccount } from 'wagmi';

import { OutcomeBadge } from '@/components/ui/Badge';
import { Button, type ButtonVariant } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { TxStatus } from '@/components/ui/TxStatus';
import { useConfig } from '@/lib/api/hooks';
import { arcTestnet } from '@/lib/chain/arc';
import {
  claimFundingResidualOnArc,
  closeoutOnArc,
  observeResolutionOnArc,
  redeemOnArc,
  resolveOnArc,
  sweepProtocolAfterCloseoutOnArc,
  type ResolutionChoice,
} from '@/lib/chain/transactions';
import {
  type IndexedSettlementEvents,
  useSettlementStatus,
} from '@/lib/chain/useSettlementStatus';
import { useTxFlow } from '@/lib/chain/useTxFlow';
import {
  formatDateTime,
  formatRaw,
  formatUsdc,
  shortAddress,
} from '@/lib/format';

import styles from './SettlementPanel.module.css';

type SettlementAction =
  | { kind: 'resolve' }
  | { kind: 'observe' }
  | { kind: 'redeem'; outcome: 'YES' | 'NO' }
  | { kind: 'closeout' }
  | { kind: 'claim' }
  | { kind: 'sweep' };

const PAYOUTS: Record<ResolutionChoice, readonly [number, number]> = {
  YES: [1, 0],
  NO: [0, 1],
  INVALID: [1, 1],
};

function sameAddress(left?: string, right?: string) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function actionTitle(
  action: SettlementAction | null,
  resolvingEarly: boolean,
) {
  if (!action) return 'Settlement action';
  if (action.kind === 'resolve') {
    return resolvingEarly
      ? 'Resolve early · end market now'
      : 'Resolve this market';
  }
  if (action.kind === 'observe') return 'Observe the resolution';
  if (action.kind === 'redeem') return `Redeem ${action.outcome}`;
  if (action.kind === 'closeout') return 'Close out this market';
  if (action.kind === 'claim') return 'Claim funding residual';
  return 'Sweep protocol closeout funds';
}

function actionLabel(
  action: SettlementAction | null,
  phase: string,
  outcome: ResolutionChoice,
  resolvingEarly: boolean,
) {
  if (phase === 'reverted') return 'Retry action';
  if (phase === 'confirmed') return 'Confirmed';
  if (!action) return 'Confirm';
  if (action.kind === 'resolve') {
    return resolvingEarly
      ? `Sign & end as ${outcome}`
      : `Sign & resolve ${outcome}`;
  }
  if (action.kind === 'observe') return 'Observe resolution';
  if (action.kind === 'redeem') return `Redeem ${action.outcome}`;
  if (action.kind === 'closeout') return 'Close out';
  if (action.kind === 'claim') return 'Claim residual';
  return 'Sweep protocol funds';
}

function OutcomeMark({ outcome }: { outcome: ResolutionOutcome }) {
  return outcome === 'INVALID' ? (
    <span className={styles.invalidBadge}>INVALID</span>
  ) : (
    <OutcomeBadge outcome={outcome} />
  );
}

function ConnectionButton({
  connected,
  wrongNetwork,
  children,
  disabled,
  onClick,
  variant = 'neutral',
}: {
  connected: boolean;
  wrongNetwork: boolean;
  children: string;
  disabled?: boolean;
  onClick: () => void;
  variant?: ButtonVariant;
}) {
  return (
    <Button
      className={styles.moneyButton}
      disabled={!connected || wrongNetwork || disabled}
      fullWidth
      onClick={onClick}
      variant={variant}
    >
      {!connected ? 'Connect wallet' : wrongNetwork ? 'Switch to Arc' : children}
    </Button>
  );
}

export function SettlementPanel({
  market,
  settlementEvents = {
    protocolSweepCompleted: false,
    protocolSweptRaw: '0',
  },
}: {
  market: Market;
  settlementEvents?: IndexedSettlementEvents;
}) {
  const [selectedOutcome, setSelectedOutcome] =
    useState<ResolutionChoice>('YES');
  const [action, setAction] = useState<SettlementAction | null>(null);
  const { address, chainId, isConnected } = useAccount();
  const config = useConfig();
  const status = useSettlementStatus(market, address, settlementEvents);
  const settlement = status.data;
  const tx = useTxFlow();
  const wrongNetwork = isConnected && chainId !== arcTestnet.id;
  const resolvingEarly =
    settlement !== undefined &&
    settlement.lifecycleState < 3 &&
    settlement.chainTimestamp < settlement.tradingEndsAt;
  const committeeSigner =
    Boolean(address) &&
    Boolean(
      config.data?.committee.signers.some((signer) =>
        sameAddress(signer, address),
      ),
    );

  function openAction(nextAction: SettlementAction) {
    tx.reset();
    setAction(nextAction);
  }

  function closeAction() {
    if (tx.isBusy) return;
    setAction(null);
    tx.reset();
  }

  async function handleAction() {
    if (!address || !action) return;
    const result = await tx.execute(async (report) => {
      if (action.kind === 'resolve') {
        return resolveOnArc({
          account: address,
          marketId: BigInt(market.id),
          outcome: selectedOutcome,
          report,
        });
      }
      if (action.kind === 'observe') {
        return observeResolutionOnArc({
          account: address,
          marketId: BigInt(market.id),
          report,
        });
      }
      if (action.kind === 'redeem') {
        return redeemOnArc({
          account: address,
          marketId: BigInt(market.id),
          outcome: action.outcome,
          report,
        });
      }
      if (action.kind === 'closeout') {
        return closeoutOnArc({
          account: address,
          marketId: BigInt(market.id),
          report,
        });
      }
      if (action.kind === 'claim') {
        return claimFundingResidualOnArc({
          account: address,
          marketId: BigInt(market.id),
          report,
        });
      }
      return sweepProtocolAfterCloseoutOnArc({
        account: address,
        marketId: BigInt(market.id),
        report,
      });
    });
    if (!result) return;
    // Resolution/position/activity display state arrives through the backend.
    // Settlement guards remain fresh direct-chain reads.
    await status.refetch();
  }

  function modalCopy() {
    if (!action) return null;
    if (action.kind === 'resolve') {
      const payouts = PAYOUTS[selectedOutcome];
      return (
        <>
          <p>
            The client re-reads committee membership, the snapshotted threshold,
            question nonce, lifecycle, deadline, and the oracle digest. The wallet
            signs the deployed adapter&apos;s EIP-191 message, then submits{' '}
            <code>
              resolve(questionId, [{payouts.join(', ')}], [signature])
            </code>
            .
          </p>
          <p className={styles.warning}>
            {resolvingEarly
              ? 'You are calling a known outcome before the trading deadline. Confirming immediately stops all bonding-curve and order-book trading and settles the outcome in Conditional Tokens. Verify the outcome before signing; resolution is final.'
              : 'Resolution is final in Conditional Tokens. Verify the outcome before signing.'}
          </p>
        </>
      );
    }
    if (action.kind === 'observe') {
      return (
        <p>
          This re-reads the CTF payout denominator, then calls{' '}
          <code>observeResolution({market.id})</code>. Anyone may advance the
          market to ResolvedObserved.
        </p>
      );
    }
    if (action.kind === 'redeem') {
      const indexSet = action.outcome === 'YES' ? 1 : 2;
      return (
        <p>
          The live token balance and payout vector are re-read, then Conditional
          Tokens receives{' '}
          <code>
            redeemPositions(USDC, bytes32(0), conditionId, [{indexSet}])
          </code>
          .
        </p>
      );
    }
    if (action.kind === 'closeout') {
      return (
        <p>
          This re-checks ResolvedObserved state, then calls{' '}
          <code>closeout({market.id})</code>. LMSR terminal accounting becomes
          final.
        </p>
      );
    }
    if (action.kind === 'claim') {
      return (
        <p>
          Creator funding shares and terminal residual are re-read before calling{' '}
          <code>claimFundingResidual({market.id})</code>.
        </p>
      );
    }
    return (
      <p>
        Closeout fees and protocol PnL are re-read before calling{' '}
        <code>sweepProtocolAfterCloseout({market.id})</code>. Funds go to the
        configured protocol depth account, not the caller.
      </p>
    );
  }

  if (status.isLoading || !settlement) {
    return (
      <aside className={styles.sticky}>
        <Card className={styles.card}>
          <h2>Settlement</h2>
          <p
            className={styles.readState}
            role={status.error ? 'alert' : 'status'}
          >
            {status.error
              ? 'Live settlement data is temporarily unavailable. No settlement action is shown until the Arc read succeeds.'
              : 'Reading live lifecycle, oracle, CTF, and LMSR state…'}
          </p>
          {status.error && (
            <Button onClick={() => void status.refetch()} size="small" variant="neutral">
              Try the live read again
            </Button>
          )}
        </Card>
      </aside>
    );
  }

  const live = settlement;
  const thresholdOne =
    config.data?.committee.threshold === 1 &&
    live.questionThreshold === 1n;
  const canResolve =
    committeeSigner &&
    live.snapshotMember &&
    thresholdOne &&
    !live.oracleResolved;
  const creator = sameAddress(address, live.creator);

  return (
    <aside className={styles.sticky}>
      <Card className={styles.card}>
        <div className={styles.heading}>
          <div>
            <span className={styles.kicker}>On-chain settlement</span>
            <h2>
              {live.lifecycleState === 5
                ? 'Market closed out'
                : live.lifecycleState === 4
                  ? 'Redeem or close out'
                  : live.oracleResolved
                    ? 'Resolution ready to observe'
                    : resolvingEarly && committeeSigner
                      ? 'Resolve early'
                      : 'Resolution pending'}
            </h2>
          </div>
          {live.outcome && <OutcomeMark outcome={live.outcome} />}
        </div>

        <table className={styles.stateTable}>
          <tbody>
            <tr>
              <th>Phase</th>
              <td>
                {live.lifecycleState === 5
                  ? 'ClosedOut'
                  : live.lifecycleState === 4
                    ? 'ResolvedObserved'
                    : live.oracleResolved
                      ? 'Oracle resolved'
                      : 'Awaiting committee'}
              </td>
            </tr>
            <tr>
              <th>Trading deadline</th>
              <td className="numeric">{formatDateTime(live.tradingEndsAt)}</td>
            </tr>
            <tr>
              <th>Committee</th>
              <td className="numeric">
                {config.data
                  ? `${config.data.committee.threshold} of ${config.data.committee.signers.length}`
                  : 'Reading…'}
              </td>
            </tr>
          </tbody>
        </table>

        {!live.oracleResolved && live.lifecycleState < 4 && (
          <section className={styles.section}>
            <p className={styles.explainer}>
              {resolvingEarly
                ? 'When the real-world outcome is already known, a committee signer may end this market ahead of its deadline. Resolving early immediately stops curve and order-book trading and moves the market into settlement.'
                : 'Trading has ended or the market has graduated. A committee signer must publish the final payout vector.'}
            </p>
            {committeeSigner ? (
              <>
                <fieldset className={styles.outcomeFieldset}>
                  <legend>Final outcome</legend>
                  <div>
                    {(['YES', 'NO', 'INVALID'] as const).map((outcome) => (
                      <button
                        aria-pressed={selectedOutcome === outcome}
                        className={`${styles.outcomeChoice} ${
                          styles[outcome.toLowerCase()]
                        }`}
                        key={outcome}
                        onClick={() => setSelectedOutcome(outcome)}
                        type="button"
                      >
                        <span>{outcome}</span>
                        <code>[{PAYOUTS[outcome].join(',')}]</code>
                      </button>
                    ))}
                  </div>
                </fieldset>
                <ConnectionButton
                  connected={isConnected}
                  disabled={!canResolve}
                  onClick={() => openAction({ kind: 'resolve' })}
                  variant={
                    selectedOutcome === 'YES'
                      ? 'mint'
                      : selectedOutcome === 'NO'
                        ? 'sky'
                        : 'neutral'
                  }
                  wrongNetwork={wrongNetwork}
                >
                  {resolvingEarly
                    ? `End market now · ${selectedOutcome}`
                    : `Resolve as ${selectedOutcome}`}
                </ConnectionButton>
                {!live.snapshotMember && (
                  <p className={styles.readState}>
                    This current signer is not in this question&apos;s snapshotted
                    committee.
                  </p>
                )}
                {!thresholdOne && (
                  <p className={styles.readState}>
                    This control supports the demo threshold-1 flow only.
                  </p>
                )}
              </>
            ) : (
              <div className={styles.readOnly}>
                <strong>Read-only</strong>
                <span>
                  {!isConnected
                    ? 'Connect the committee wallet to reveal resolve controls.'
                    : config.error
                      ? 'Committee configuration is temporarily unavailable.'
                      : 'The connected wallet is not a current committee signer.'}
                </span>
              </div>
            )}
          </section>
        )}

        {live.oracleResolved && live.lifecycleState < 4 && (
          <section className={styles.section}>
            <p className={styles.explainer}>
              Conditional Tokens records payouts{' '}
              <strong className="numeric">
                [{live.payoutYes.toString()}, {live.payoutNo.toString()}] /
                {live.payoutDenominator.toString()}
              </strong>
              . The LMSR has not observed them yet.
            </p>
            <ConnectionButton
              connected={isConnected}
              onClick={() => openAction({ kind: 'observe' })}
              variant="neutral"
              wrongNetwork={wrongNetwork}
            >
              Observe resolution
            </ConnectionButton>
            <p className={styles.readState}>Callable by any connected account.</p>
          </section>
        )}

        {live.payoutDenominator > 0n && (
          <section className={styles.section}>
            <h3>Wallet positions</h3>
            <div className={styles.positionTableWrap}>
              <table className={styles.positionTable}>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Held</th>
                    <th>Redeemable</th>
                    <th aria-label="Action" />
                  </tr>
                </thead>
                <tbody>
                  {(['YES', 'NO'] as const).map((outcome) => {
                    const held =
                      outcome === 'YES'
                        ? live.yesBalanceRaw
                        : live.noBalanceRaw;
                    const redeemable =
                      outcome === 'YES'
                        ? live.yesRedeemableRaw
                        : live.noRedeemableRaw;
                    return (
                      <tr key={outcome}>
                        <th>{outcome}</th>
                        <td className="numeric">
                          {formatRaw(held.toString(), {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </td>
                        <td className="numeric">
                          {formatUsdc(redeemable.toString())}
                        </td>
                        <td>
                          <Button
                            className={styles.inlineMoneyButton}
                            disabled={
                              !isConnected ||
                              wrongNetwork ||
                              redeemable === 0n
                            }
                            onClick={() =>
                              openAction({ kind: 'redeem', outcome })
                            }
                            size="small"
                            variant={outcome === 'YES' ? 'mint' : 'sky'}
                          >
                            Redeem
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {live.lifecycleState === 4 && (
          <section className={styles.section}>
            <ConnectionButton
              connected={isConnected}
              onClick={() => openAction({ kind: 'closeout' })}
              variant="neutral"
              wrongNetwork={wrongNetwork}
            >
              Close out market
            </ConnectionButton>
            <p className={styles.readState}>
              Closeout finalizes LMSR accounting. Check redeemable positions
              first.
            </p>
          </section>
        )}

        {live.lifecycleState === 5 && (
          <>
            <section className={styles.section}>
              <h3>Terminal accounting</h3>
              <table className={styles.moneyTable}>
                <tbody>
                  <tr>
                    <th>Funding residual</th>
                    <td className="numeric">
                      {formatUsdc(live.fundingResidualRaw.toString())} USDC
                    </td>
                  </tr>
                  <tr>
                    <th>Residual claimed</th>
                    <td className="numeric">
                      {formatUsdc(live.claimedResidualRaw.toString())} USDC
                    </td>
                  </tr>
                  <tr>
                    <th>Funding loss</th>
                    <td className="numeric">
                      {formatUsdc(live.fundingLossRaw.toString())} USDC
                    </td>
                  </tr>
                  <tr>
                    <th>Protocol PnL</th>
                    <td className="numeric">
                      {formatUsdc(live.protocolPnlRaw.toString())} USDC
                    </td>
                  </tr>
                  <tr>
                    <th>Protocol sweep</th>
                    <td className="numeric">
                      {live.protocolSweepCompleted
                        ? `${formatUsdc(live.protocolSweptRaw.toString())} USDC · complete`
                        : `${formatUsdc(
                            live.protocolSweepAvailableRaw.toString(),
                          )} USDC · available`}
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
            {creator ? (
              <section className={styles.creatorActions}>
                <span>Creator closeout controls</span>
                <ConnectionButton
                  connected={isConnected}
                  disabled={live.creatorResidualClaimableRaw === 0n}
                  onClick={() => openAction({ kind: 'claim' })}
                  variant="neutral"
                  wrongNetwork={wrongNetwork}
                >
                  {live.creatorResidualClaimableRaw > 0n
                    ? `Claim ${formatUsdc(
                        live.creatorResidualClaimableRaw.toString(),
                      )} USDC residual`
                    : live.claimedResidualRaw > 0n
                      ? 'Residual claimed'
                      : 'No residual to claim'}
                </ConnectionButton>
                <ConnectionButton
                  connected={isConnected}
                  disabled={
                    live.protocolSweepCompleted ||
                    live.protocolSweepAvailableRaw === 0n
                  }
                  onClick={() => openAction({ kind: 'sweep' })}
                  variant="neutral"
                  wrongNetwork={wrongNetwork}
                >
                  {live.protocolSweepCompleted
                    ? 'Protocol sweep complete'
                    : 'Sweep protocol funds'}
                </ConnectionButton>
              </section>
            ) : (
              <div className={styles.readOnly}>
                <strong>Closeout final</strong>
                <span>
                  Creator controls belong to{' '}
                  <code>{shortAddress(live.creator, 6, 4)}</code>.
                </span>
              </div>
            )}
          </>
        )}
      </Card>

      <ConfirmModal
        closeDisabled={tx.isBusy}
        closeOnConfirm={false}
        confirmDisabled={tx.isBusy || tx.state.phase === 'confirmed'}
        confirmLabel={actionLabel(
          action,
          tx.state.phase,
          selectedOutcome,
          resolvingEarly,
        )}
        kicker="Live Arc settlement"
        onClose={closeAction}
        onConfirm={handleAction}
        open={action !== null}
        title={actionTitle(action, resolvingEarly)}
      >
        {modalCopy()}
        <TxStatus state={tx.state} />
      </ConfirmModal>
    </aside>
  );
}
