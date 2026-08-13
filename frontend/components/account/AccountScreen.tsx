'use client';

import type { Market } from '@predex-pump/shared/domain';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useAccount as useWalletAccount, useConnect } from 'wagmi';

import { MarketCard } from '@/components/feed/MarketCard';
import { useAuth } from '@/components/providers/AuthProvider';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { StatePanel } from '@/components/ui/StatePanel';
import { useAccountProfile } from '@/lib/api/hooks';
import { backendRestClient } from '@/lib/api/rest-client';
import {
  formatSignedUsdc,
  formatUsdc,
  shortAddress,
} from '@/lib/format';

import { GatewayDepositPanel } from './GatewayDepositPanel';
import styles from './AccountScreen.module.css';

function InlineState({ title, message }: { title: string; message: string }) {
  return (
    <Card className={styles.inlineState} role="status">
      <strong>{title}</strong>
      <p>{message}</p>
    </Card>
  );
}

function MarketSection({
  title,
  description,
  markets,
  empty,
}: {
  title: string;
  description: string;
  markets: Market[];
  empty: string;
}) {
  return (
    <section className={styles.marketSection}>
      <div className={styles.sectionHeading}>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className={styles.count}>{markets.length}</span>
      </div>
      {markets.length === 0 ? (
        <div className={styles.empty}>{empty}</div>
      ) : (
        <div className={styles.marketGrid}>
          {markets.map((market) => (
            <MarketCard key={market.id} market={market} />
          ))}
        </div>
      )}
    </section>
  );
}

export function AccountScreen() {
  const queryClient = useQueryClient();
  const { isConnected } = useWalletAccount();
  const {
    connect,
    connectors,
    isPending: isConnecting,
  } = useConnect();
  const {
    session,
    isLoading: sessionLoading,
    isSigningIn,
    error: authError,
    signIn,
  } = useAuth();
  const authenticated = session?.authenticated === true;
  const {
    data,
    isLoading,
    error,
    refetch,
  } = useAccountProfile(authenticated);
  const [displayNameDraft, setDisplayNameDraft] = useState<string | null>(null);
  const [rememberRecentlyViewedDraft, setRememberRecentlyViewedDraft] =
    useState<boolean | undefined>(undefined);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);

  async function saveProfile() {
    if (!data) return;
    const displayName = displayNameDraft ?? data.profile.displayName ?? '';
    const rememberRecentlyViewed =
      rememberRecentlyViewedDraft ??
      data.profile.preferences.rememberRecentlyViewed;
    setIsSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const updated = await backendRestClient.updateAccountProfile({
        displayName,
        preferences: { rememberRecentlyViewed },
      });
      queryClient.setQueryData(['account-profile'], updated);
      setDisplayNameDraft(null);
      setRememberRecentlyViewedDraft(undefined);
      setSaved(true);
    } catch (caught) {
      setSaveError(
        caught instanceof Error ? caught : new Error('Profile changes were not saved.'),
      );
    } finally {
      setIsSaving(false);
    }
  }

  const connector = connectors[0];
  const header = (
    <header className={styles.header}>
      <div>
        <span className={styles.kicker}>Optional account layer</span>
        <h1>Your name and your on-chain trail.</h1>
        <p>
          Signing in unlocks profile, watchlist, and recent-view features. Creating,
          trading, resolving, redeeming, and closing out still require only your wallet.
        </p>
      </div>
      {authenticated && (
        <code className={`${styles.address} mono`}>
          {shortAddress(session.address, 6, 4)}
        </code>
      )}
    </header>
  );

  if (sessionLoading) {
    return (
      <main className={styles.page}>
        {header}
        <InlineState
          message="Checking the saved HttpOnly session for this browser."
          title="Restoring sign-in…"
        />
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className={styles.page}>
        {header}
        <StatePanel
          actions={
            <>
              {!isConnected ? (
                <Button
                  disabled={!connector || isConnecting}
                  onClick={() => connector && connect({ connector })}
                  variant="coral"
                >
                  {isConnecting ? 'Connecting…' : 'Connect wallet'}
                </Button>
              ) : (
                <Button
                  disabled={isSigningIn}
                  onClick={() => void signIn()}
                  variant="coral"
                >
                  {isSigningIn ? 'Waiting for signature…' : 'Sign in with Ethereum'}
                </Button>
              )}
              <Link className={buttonClassName('neutral')} href="/">
                Keep browsing
              </Link>
            </>
          }
          message={
            authError?.message ??
            'One EIP-4361 signature creates an expiring session. It is not a transaction and does not grant spending authority.'
          }
          showMascot={false}
          state={authError ? 'error' : 'empty'}
          title={isConnected ? 'Sign to open your profile' : 'Connect, then sign in'}
        />
      </main>
    );
  }

  if (isLoading) {
    return (
      <main className={styles.page}>
        {header}
        <InlineState
          message="Joining your optional account data to the indexed Arc read model."
          title="Assembling your profile…"
        />
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className={styles.page}>
        {header}
        <Card className={styles.inlineState} role="alert">
          <strong>Your profile could not load</strong>
          <p>{error?.message ?? 'The account API returned no profile.'}</p>
          <Button onClick={refetch} size="small" variant="neutral">
            Try again
          </Button>
        </Card>
      </main>
    );
  }

  const totalPnlRaw = (
    BigInt(data.trackRecord.realizedPnlRaw) +
    BigInt(data.trackRecord.unrealizedPnlRaw)
  ).toString();
  const displayName = displayNameDraft ?? data.profile.displayName ?? '';
  const rememberRecentlyViewed =
    rememberRecentlyViewedDraft ??
    data.profile.preferences.rememberRecentlyViewed;

  return (
    <main className={styles.page}>
      {header}

      <section className={styles.summaryGrid} aria-label="Indexed track record">
        <Card className={styles.profileCard}>
          <div className={styles.cardHeading}>
            <div>
              <span>Off-chain profile</span>
              <h2>{data.profile.displayName || 'Unnamed wallet'}</h2>
            </div>
            <span className={styles.optional}>Optional</span>
          </div>
          <label className={styles.field}>
            <span>Display name</span>
            <input
              maxLength={40}
              onChange={(event) => {
                setDisplayNameDraft(event.target.value);
                setSaved(false);
              }}
              placeholder="How should predex address you?"
              value={displayName}
            />
          </label>
          <label className={styles.checkField}>
            <input
              checked={rememberRecentlyViewed}
              onChange={(event) => {
                setRememberRecentlyViewedDraft(event.target.checked);
                setSaved(false);
              }}
              type="checkbox"
            />
            <span>
              <strong>Remember recently viewed markets</strong>
              <small>Turning this off deletes stored market-view records.</small>
            </span>
          </label>
          <div className={styles.saveRow}>
            <Button
              disabled={isSaving}
              onClick={() => void saveProfile()}
              size="small"
              variant="coral"
            >
              {isSaving ? 'Saving…' : 'Save profile'}
            </Button>
            {saved && <span className={styles.saved}>Saved</span>}
            {saveError && <span className={styles.saveError}>{saveError.message}</span>}
          </div>
        </Card>

        <Card className={styles.trackCard}>
          <div className={styles.cardHeading}>
            <div>
              <span>Indexed from Arc</span>
              <h2>Track record</h2>
            </div>
            <span className={styles.live}>Live</span>
          </div>
          <dl className={styles.metrics}>
            <div>
              <dt>Markets created</dt>
              <dd className="numeric">{data.trackRecord.marketsCreated}</dd>
            </div>
            <div>
              <dt>Markets traded</dt>
              <dd className="numeric">{data.trackRecord.marketsTraded}</dd>
            </div>
            <div>
              <dt>Trades</dt>
              <dd className="numeric">{data.trackRecord.tradeCount}</dd>
            </div>
            <div>
              <dt>Volume traded</dt>
              <dd>
                <NumberDisplay size="body">
                  {formatUsdc(data.trackRecord.volumeTradedRaw)} USDC
                </NumberDisplay>
              </dd>
            </div>
            <div className={styles.pnlMetric}>
              <dt>Estimated total PnL</dt>
              <dd>
                <NumberDisplay size="body">
                  {formatSignedUsdc(totalPnlRaw)} USDC
                </NumberDisplay>
              </dd>
            </div>
          </dl>
          <p className={styles.estimateNote}>
            Positions, trades, and PnL come from the indexer. PnL remains an estimate,
            not settlement authority.
          </p>
        </Card>
      </section>

      <GatewayDepositPanel sessionAddress={session.address} />

      <MarketSection
        description="Markets you explicitly saved from a market page."
        empty="No saved markets yet. Open a market and choose Add to watchlist."
        markets={data.watchlist}
        title="Watchlist"
      />
      <MarketSection
        description="Created by this address, read from MarketCreated events."
        empty="This address has not created an indexed market."
        markets={data.createdMarkets}
        title="Created"
      />
      <MarketSection
        description="Ordered by this address's latest indexed trade."
        empty="This address has no indexed curve or order-book trades."
        markets={data.tradedMarkets}
        title="Traded"
      />
      {data.profile.preferences.rememberRecentlyViewed && (
        <MarketSection
          description="One latest-view record per market, retained only while this preference is on."
          empty="No recently viewed markets have been saved."
          markets={data.recentlyViewed}
          title="Recently viewed"
        />
      )}

      <Card className={styles.privacyCard} quiet>
        <h2>Small by design</h2>
        <p>
          Stored off-chain: display name, the recently-viewed preference, watchlist market
          IDs, one latest view per market, and accept/reject decisions for suggested duplicate
          market IDs. No question drafts, IPs, fingerprints, wallet balances, positions,
          trades, or PnL are copied into the account record.
        </p>
        <div className={styles.feedbackCounts}>
          <span>
            Dedup accepted <b className="numeric">{data.trackRecord.dedupSuggestionsAccepted}</b>
          </span>
          <span>
            Dedup rejected <b className="numeric">{data.trackRecord.dedupSuggestionsRejected}</b>
          </span>
        </div>
      </Card>
    </main>
  );
}
