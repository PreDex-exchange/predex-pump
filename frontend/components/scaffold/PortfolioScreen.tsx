'use client';

import Link from 'next/link';
import { useAccount as useWalletAccount } from 'wagmi';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { StatePanel } from '@/components/ui/StatePanel';
import { useAccount as useMockAccount, useMarkets } from '@/lib/api/hooks';
import { formatPrice, formatRaw, formatUsdc } from '@/lib/format';
import { MOCK_WALLET_ADDRESS } from '@/lib/mock/data';

import styles from './ScaffoldScreens.module.css';

export function PortfolioScreen() {
  const { address, isConnected } = useWalletAccount();
  const { data: account, isLoading } = useMockAccount(address ?? MOCK_WALLET_ADDRESS);
  const { data: markets } = useMarkets();

  if (isLoading || !account) {
    return (
      <main className={styles.page}>
        <StatePanel
          message="Loading contract-shaped positions from the local mock account."
          title="Counting your eggs…"
        />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <section className={styles.portfolioHeader}>
        <div>
          <span className={styles.kicker}>Portfolio route · Phase C1 scaffold</span>
          <h1>Your markets, held calmly.</h1>
          <p>
            {isConnected
              ? 'Mock positions are adapted to your connected address for this foundation build.'
              : 'Showing a demo portfolio. Connect a wallet in the top bar to preview its address state.'}
          </p>
        </div>
        {!isConnected && <Badge tone="neutral">Demo data</Badge>}
      </section>

      <section className={styles.summary}>
        <Card>
          <span>Positions</span>
          <NumberDisplay size="hero">{account.positions.length}</NumberDisplay>
        </Card>
        <Card>
          <span>Realized PnL</span>
          <NumberDisplay size="hero" tone="yes">
            +{formatUsdc(account.pnl.realizedRaw)} USDC
          </NumberDisplay>
        </Card>
        <Card>
          <span>Unrealized PnL</span>
          <NumberDisplay size="hero" tone="yes">
            +{formatUsdc(account.pnl.unrealizedRaw)} USDC
          </NumberDisplay>
        </Card>
      </section>

      <section className={styles.positions}>
        <div className={styles.sectionHeader}>
          <h2>Positions</h2>
          <span>Cost basis is estimated from indexed trades</span>
        </div>
        {account.positions.map((position) => {
          const market = markets?.items.find((item) => item.id === position.marketId);
          const priceRaw =
            position.outcome === 'YES' ? market?.yesPriceRaw ?? '0' : market?.noPriceRaw ?? '0';
          const valueRaw = (
            (BigInt(position.qtyRaw) * BigInt(priceRaw)) /
            1_000_000n
          ).toString();

          return (
            <Link href={`/market/${position.marketId}`} key={`${position.marketId}:${position.outcome}`}>
              <Card className={styles.positionCard} interactive>
                <div>
                  <Badge tone={position.outcome === 'YES' ? 'yes' : 'no'}>
                    {position.outcome}
                  </Badge>
                  <h3>{market?.question ?? `Market #${position.marketId}`}</h3>
                </div>
                <dl>
                  <div>
                    <dt>Held</dt>
                    <dd className="numeric">
                      {formatRaw(position.qtyRaw, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>Mark</dt>
                    <dd className="numeric">{formatPrice(priceRaw, 3)}</dd>
                  </div>
                  <div>
                    <dt>Value</dt>
                    <dd className="numeric">{formatUsdc(valueRaw)} USDC</dd>
                  </div>
                  <div>
                    <dt>PnL (est.)</dt>
                    <dd className={`${styles.positive} numeric`}>
                      +{formatUsdc(position.unrealizedPnlRaw)} USDC
                    </dd>
                  </div>
                </dl>
              </Card>
            </Link>
          );
        })}
      </section>
    </main>
  );
}
