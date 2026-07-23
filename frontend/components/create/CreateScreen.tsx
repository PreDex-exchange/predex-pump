'use client';

import type { Address, Market, RegistryConfig } from '@predex-pump/shared/domain';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { useAccount as useWalletAccount, useConnect } from 'wagmi';

import { MarketCard } from '@/components/feed/MarketCard';
import { CrackingEgg, HatchingChick } from '@/components/mascot/HatchingChick';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClassName } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { NumberDisplay } from '@/components/ui/NumberDisplay';
import { TxStatus } from '@/components/ui/TxStatus';
import { useConfig } from '@/lib/api/hooks';
import { arcTestnet } from '@/lib/chain/arc';
import { clearChainReadCache } from '@/lib/chain/client';
import {
  buildMarketMetadata,
  createMarketOnArc,
} from '@/lib/chain/transactions';
import { useTxFlow } from '@/lib/chain/useTxFlow';
import { formatUsdc, parseUsdcInput } from '@/lib/format';

import styles from './CreateScreen.module.css';

const QUESTION_MAX_LENGTH = 180;
const CATEGORIES = [
  { value: '', label: 'No category' },
  { value: 'crypto', label: 'Crypto' },
  { value: 'macro', label: 'Macro' },
  { value: 'technology', label: 'Technology' },
  { value: 'culture', label: 'Culture' },
  { value: 'climate', label: 'Climate' },
] as const;

function validateQuestion(value: string) {
  if (!value.trim()) return 'Enter a question for the market.';
  if (value.trim().length > QUESTION_MAX_LENGTH) {
    return `Keep the question to ${QUESTION_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

function validateSeed(
  value: string,
  seedRaw: string | null,
  seedFloorRaw?: string,
  seedCapRaw?: string,
) {
  if (!value.trim()) return 'Enter an initial seed amount.';
  if (seedRaw === null) return 'Use a valid USDC amount with up to 6 decimal places.';
  if (!seedFloorRaw || !seedCapRaw) return null;

  if (BigInt(seedRaw) < BigInt(seedFloorRaw) || BigInt(seedRaw) > BigInt(seedCapRaw)) {
    return `Choose a seed between ${formatUsdc(seedFloorRaw, 0)} and ${formatUsdc(
      seedCapRaw,
      0,
    )} USDC.`;
  }

  return null;
}

function formatFeeBps(bps?: number) {
  if (bps === undefined) return '—';
  return `${(bps / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

function buildPreviewMarket({
  address,
  config,
  question,
  seedRaw,
}: {
  address?: Address;
  config: RegistryConfig | null;
  question: string;
  seedRaw: string;
}): Market {
  const now = Math.floor(Date.now() / 1_000);
  return {
    id: 'preview',
    creator:
      address ??
      ('0x0000000000000000000000000000000000000000' as Address),
    question: question || 'Your market question will appear here.',
    phase: 'Opened',
    conditionId: 'Pending creation',
    questionId: 'Pending creation',
    yesTokenId: '0',
    noTokenId: '0',
    seedRaw,
    // A newly opened binary LMSR starts symmetrically. All final identifiers and
    // parameter snapshots come from the confirmed MarketCreated transaction.
    yesPriceRaw: '500000',
    noPriceRaw: '500000',
    graduationActivityRaw: '0',
    bookAddress: null,
    frozenYesPriceRaw: null,
    handoffSizeRaw: null,
    tradeCount: 0,
    volumeRaw: '0',
    params: {
      seedFloorRaw: config?.seedFloorRaw ?? '0',
      seedCapRaw: config?.seedCapRaw ?? '0',
      fCapRaw: '0',
      graduationMoneyInThresholdRaw: '1',
      graduationTollRaw: config?.graduationTollRaw ?? '0',
      inventoryTargetRaw: '0',
      protocolFeeBps: config?.protocolFeeBps ?? 0,
      depthFeeBps: 0,
      tradingWindowSeconds: 0,
      minimumTimeOpenSeconds: 0,
    },
    createdAt: now,
    tradingEndsAt: now,
    graduatedAt: null,
    resolvedAt: null,
  };
}

export function CreateScreen() {
  const [question, setQuestion] = useState('');
  const [seed, setSeed] = useState('1.00');
  const [category, setCategory] = useState('');
  const [questionTouched, setQuestionTouched] = useState(false);
  const [seedTouched, setSeedTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [createdMarketId, setCreatedMarketId] = useState<string | null | undefined>(
    undefined,
  );

  const queryClient = useQueryClient();
  const { address, chainId, isConnected } = useWalletAccount();
  const tx = useTxFlow();
  const {
    connect,
    connectors,
    error: connectError,
    isPending: isConnecting,
  } = useConnect();
  const {
    data: config,
    isLoading: configLoading,
    error: configError,
    refetch: refetchConfig,
  } = useConfig();

  const seedRaw = parseUsdcInput(seed);
  const questionError = validateQuestion(question);
  const seedError = validateSeed(
    seed,
    seedRaw,
    config?.seedFloorRaw,
    config?.seedCapRaw,
  );
  const showQuestionError = (questionTouched || submitted) && questionError;
  const showSeedError = (seedTouched || submitted) && seedError;
  const categoryLabel =
    CATEGORIES.find((item) => item.value === category)?.label ?? 'No category';
  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;
  const canLaunch =
    Boolean(config) &&
    !configError &&
    !questionError &&
    !seedError &&
    seedRaw !== null &&
    isConnected &&
    !isWrongNetwork &&
    Boolean(address);

  const previewMarket = useMemo(() => {
    return buildPreviewMarket({
      address: address?.toLowerCase() as Address | undefined,
      config,
      question: question.trim(),
      seedRaw: seedRaw ?? config?.seedFloorRaw ?? '0',
    });
  }, [address, config, question, seedRaw]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setQuestionTouched(true);
    setSeedTouched(true);

    if (canLaunch) setConfirmOpen(true);
  }

  async function handleConfirm() {
    if (!address || !config || !seedRaw || questionError || seedError) return;

    const metadata = buildMarketMetadata(question);
    const result = await tx.execute((report) =>
      createMarketOnArc({
        account: address,
        ancillaryData: metadata.ancillaryData,
        metadataHash: metadata.metadataHash,
        seedRaw: BigInt(seedRaw),
        report,
      }),
    );
    if (!result) return;

    clearChainReadCache();
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['markets'] }),
      queryClient.invalidateQueries({ queryKey: ['activity'] }),
      queryClient.invalidateQueries({ queryKey: ['config'] }),
    ]).catch(() => undefined);
    setCreatedMarketId(result.marketId);
    setSubmitted(false);
    setConfirmOpen(false);
  }

  function resetDraft() {
    setQuestion('');
    setSeed('1.00');
    setCategory('');
    setQuestionTouched(false);
    setSeedTouched(false);
    setSubmitted(false);
    setCreatedMarketId(undefined);
    tx.reset();
  }

  if (createdMarketId !== undefined) {
    return (
      <main className={`${styles.page} ${styles.successPage}`}>
        <Card className={styles.successCard}>
          <div className={styles.successArt}>
            <HatchingChick decorative />
          </div>
          <div className={styles.successCopy}>
            <Badge tone="yes">Arc transaction confirmed</Badge>
            <h1>Your market is incubating.</h1>
            <p>
              The registry created this market on Arc and transferred the six-decimal ERC-20 seed
              into the LMSR.
            </p>
            <div className={styles.successMarket}>
              <span>{categoryLabel}</span>
              <strong>{question.trim()}</strong>
              <NumberDisplay size="body">
                {formatUsdc(seedRaw ?? '0')} USDC seeded
              </NumberDisplay>
            </div>
            <div className={styles.successActions}>
              {createdMarketId ? (
                <Link
                  className={buttonClassName('coral', 'large')}
                  href={`/market/${createdMarketId}`}
                >
                  View live market
                  <span aria-hidden="true">→</span>
                </Link>
              ) : (
                <Link className={buttonClassName('coral', 'large')} href="/">
                  View live feed
                  <span aria-hidden="true">→</span>
                </Link>
              )}
              <Button onClick={resetDraft} size="large" variant="neutral">
                Launch another
              </Button>
            </div>
          </div>
        </Card>
      </main>
    );
  }

  const connector = connectors[0];

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div>
          <span className={styles.kicker}>Create a market</span>
          <h1>Give a good question somewhere to hatch.</h1>
          <p>
            Set the question and starting liquidity. You&apos;ll review every number before this
            launch is signed and submitted to the live Arc registry.
          </p>
        </div>
        <CrackingEgg progress={34} />
      </section>

      <div className={styles.layout}>
        <Card className={styles.formCard}>
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.step}>Draft</span>
              <h2>Market details</h2>
            </div>
            <Badge tone="yes">Live Arc</Badge>
          </div>

          <form noValidate onSubmit={handleSubmit}>
            <label className={styles.field}>
              <span className={styles.labelRow}>
                <span>Question</span>
                <span
                  className={
                    question.trim().length > QUESTION_MAX_LENGTH ? styles.countError : ''
                  }
                >
                  {question.trim().length}/{QUESTION_MAX_LENGTH}
                </span>
              </span>
              <textarea
                aria-describedby="question-help question-error"
                aria-invalid={Boolean(showQuestionError)}
                className={showQuestionError ? styles.invalid : ''}
                onBlur={() => setQuestionTouched(true)}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Will…?"
                rows={4}
                value={question}
              />
              <span className={styles.help} id="question-help">
                Keep it specific, measurable, and clear about when it resolves.
              </span>
              {showQuestionError && (
                <span className={styles.error} id="question-error" role="alert">
                  {questionError}
                </span>
              )}
            </label>

            <label className={styles.field}>
              <span className={styles.labelRow}>
                <span>Initial seed</span>
                <span>USDC</span>
              </span>
              <span
                className={`${styles.amountField} ${
                  showSeedError ? styles.invalid : ''
                }`}
              >
                <input
                  aria-describedby="seed-help seed-error"
                  aria-invalid={Boolean(showSeedError)}
                  autoComplete="off"
                  inputMode="decimal"
                  onBlur={() => setSeedTouched(true)}
                  onChange={(event) => setSeed(event.target.value)}
                  value={seed}
                />
                <b>USDC</b>
              </span>
              <span className={styles.help} id="seed-help">
                {config
                  ? `${formatUsdc(config.seedFloorRaw, 0)}–${formatUsdc(
                      config.seedCapRaw,
                      0,
                    )} USDC from the live registry.`
                  : configLoading
                    ? 'Reading the live registry range…'
                    : 'Registry range unavailable.'}
              </span>
              {showSeedError && (
                <span className={styles.error} id="seed-error" role="alert">
                  {seedError}
                </span>
              )}
            </label>

            <label className={styles.field}>
              <span className={styles.labelRow}>
                <span>Category</span>
                <span>Optional</span>
              </span>
              <span className={styles.selectField}>
                <select
                  onChange={(event) => setCategory(event.target.value)}
                  value={category}
                >
                  {CATEGORIES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <span aria-hidden="true">⌄</span>
              </span>
              <span className={styles.help}>
                Categories help people scan the feed; they do not affect market economics.
              </span>
            </label>

            <div className={styles.committee}>
              <span>Resolution committee</span>
              <strong>
                Arc committee · {config?.committee.threshold ?? '—'} of{' '}
                {config?.committee.signers.length ?? '—'}
              </strong>
              <small>Read from the deployed committee oracle.</small>
            </div>

            {configError && (
              <div className={styles.configError} role="alert">
                <span>The live registry rules could not load.</span>
                <Button onClick={refetchConfig} size="small" variant="ghost">
                  Try again
                </Button>
              </div>
            )}

            {!isConnected && (
              <div className={styles.walletNotice}>
                <div>
                  <strong>Connect a wallet to launch</strong>
                  <span>The connected address will create and seed the market on Arc.</span>
                </div>
                <Button
                  disabled={!connector || isConnecting}
                  onClick={() => connector && connect({ connector })}
                  size="small"
                  variant="neutral"
                >
                  {isConnecting
                    ? 'Connecting…'
                    : connector
                      ? 'Connect wallet'
                      : 'No wallet found'}
                </Button>
              </div>
            )}
            {connectError && !isConnected && (
              <p className={styles.connectError} role="status">
                Wallet connection was not completed. You can also use the control in the header.
              </p>
            )}
            {isWrongNetwork && (
              <p className={styles.connectError} role="alert">
                Switch the wallet to Arc Testnet in the header before launching.
              </p>
            )}

            <Button
              disabled={!canLaunch}
              fullWidth
              size="large"
              type="submit"
              variant="coral"
            >
              Launch a market
              <span aria-hidden="true">→</span>
            </Button>
            <p className={styles.stubNote}>
              Uses ERC-20 USDC only. The wallet may request a Registry approval before createMarket.
            </p>
          </form>
        </Card>

        <div className={styles.previewColumn}>
          <Card className={styles.rulesCard} quiet>
            <div className={styles.rulesHeading}>
              <div>
                <span className={styles.step}>Registry rules</span>
                <h2>Know the numbers</h2>
              </div>
              <span className={styles.liveDot}>
                <span aria-hidden="true" />
                Live config
              </span>
            </div>
            <dl className={styles.rules}>
              <div>
                <dt>Seed range</dt>
                <dd>
                  <NumberDisplay size="small">
                    {config
                      ? `${formatUsdc(config.seedFloorRaw, 0)}–${formatUsdc(
                          config.seedCapRaw,
                          0,
                        )} USDC`
                      : '—'}
                  </NumberDisplay>
                </dd>
                <small>Starting liquidity you choose today.</small>
              </div>
              <div>
                <dt>Graduation toll</dt>
                <dd>
                  <NumberDisplay size="small">
                    {config ? `${formatUsdc(config.graduationTollRaw)} USDC` : '—'}
                  </NumberDisplay>
                </dd>
                <small>Applied only when the market hatches.</small>
              </div>
              <div>
                <dt>Protocol fee</dt>
                <dd>
                  <NumberDisplay size="small">
                    {formatFeeBps(config?.protocolFeeBps)}
                  </NumberDisplay>
                </dd>
                <small>Applied to each bonding-curve trade.</small>
              </div>
            </dl>
          </Card>

          <section aria-live="polite" className={styles.preview}>
            <div className={styles.previewHeading}>
              <div>
                <span className={styles.step}>Live preview</span>
                <h2>Feed card</h2>
              </div>
              <div className={styles.previewMeta}>
                <Badge tone="neutral">{categoryLabel}</Badge>
                <NumberDisplay size="small">
                  {seedRaw ? formatUsdc(seedRaw) : '—'} USDC seed
                </NumberDisplay>
              </div>
            </div>
            <MarketCard href={null} market={previewMarket} />
          </section>
        </div>
      </div>

      <ConfirmModal
        closeDisabled={tx.isBusy}
        closeOnConfirm={false}
        confirmDisabled={tx.isBusy || tx.state.phase === 'confirmed'}
        confirmLabel={
          tx.state.phase === 'reverted' ? 'Retry live launch' : 'Approve & launch'
        }
        kicker="Live Arc transaction"
        onClose={() => {
          if (tx.isBusy) return;
          setConfirmOpen(false);
          tx.reset();
        }}
        onConfirm={handleConfirm}
        open={confirmOpen}
        title="Review your market"
      >
        <p className={styles.confirmQuestion}>{question.trim()}</p>
        <dl className={styles.confirmRows}>
          <div>
            <dt>Category</dt>
            <dd>{categoryLabel}</dd>
          </div>
          <div>
            <dt>Seed</dt>
            <dd className="numeric">
              {seedRaw ? formatUsdc(seedRaw) : '—'} USDC
            </dd>
          </div>
          <div>
            <dt>Graduation toll</dt>
            <dd className="numeric">
              {config ? formatUsdc(config.graduationTollRaw) : '—'} USDC
            </dd>
          </div>
          <div>
            <dt>Protocol fee</dt>
            <dd className="numeric">{formatFeeBps(config?.protocolFeeBps)} per trade</dd>
          </div>
        </dl>
        <p className={styles.confirmNote}>
          Transaction state is re-read immediately before signing. If needed, approve Registry
          spending first; then sign createMarket. No native value is sent.
        </p>
        <TxStatus state={tx.state} />
      </ConfirmModal>
    </main>
  );
}
