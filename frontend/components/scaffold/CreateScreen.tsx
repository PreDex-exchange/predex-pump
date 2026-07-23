'use client';

import { useState } from 'react';

import { CrackingEgg } from '@/components/mascot/HatchingChick';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { useConfig } from '@/lib/api/hooks';
import { formatUsdc } from '@/lib/format';

import styles from './ScaffoldScreens.module.css';

export function CreateScreen() {
  const [question, setQuestion] = useState('');
  const [seed, setSeed] = useState('500.00');
  const [open, setOpen] = useState(false);
  const { data: config } = useConfig();

  return (
    <main className={styles.page}>
      <section className={styles.intro}>
        <div>
          <span className={styles.kicker}>Create route · Phase C1 scaffold</span>
          <h1>Give a question somewhere to hatch.</h1>
          <p>
            Set the market question and starting depth. The live create flow, approvals, and
            registry write arrive in a later phase.
          </p>
        </div>
        <CrackingEgg progress={22} />
      </section>

      <div className={styles.createGrid}>
        <Card>
          <div className={styles.stepLabel}>1 · Market</div>
          <label className={styles.field}>
            Question
            <textarea
              maxLength={180}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Will…?"
              rows={4}
              value={question}
            />
            <small>{question.length}/180 characters</small>
          </label>
          <label className={styles.field}>
            Initial seed
            <span className={styles.amountField}>
              <input
                inputMode="decimal"
                onChange={(event) => setSeed(event.target.value)}
                value={seed}
              />
              <b>USDC</b>
            </span>
            <small>
              Mock registry range:{' '}
              <span className="numeric">
                {config ? formatUsdc(config.seedFloorRaw, 0) : '—'}–
                {config ? formatUsdc(config.seedCapRaw, 0) : '—'} USDC
              </span>
            </small>
          </label>
          <div className={styles.disabledField}>
            <span>Resolution committee</span>
            <strong>
              Arc committee · {config?.committee.threshold ?? '—'} of{' '}
              {config?.committee.signers.length ?? '—'}
            </strong>
            <small>Configured by the shared registry contract.</small>
          </div>
          <Button
            disabled={!question.trim()}
            fullWidth
            onClick={() => setOpen(true)}
            size="large"
            variant="coral"
          >
            Preview launch
          </Button>
        </Card>

        <Card className={styles.sideCard}>
          <div className={styles.stepLabel}>How hatching works</div>
          <ol className={styles.explainer}>
            <li>
              <span>1</span>
              <div>
                <strong>Incubate</strong>
                <p>Your seed opens an LMSR bonding curve immediately.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Build activity</strong>
                <p>Non-creator flow advances the graduation threshold.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Graduate</strong>
                <p>Complete sets hand off into the transparent order book.</p>
              </div>
            </li>
          </ol>
          <p className={styles.foundationNote}>
            This route is visually scaffolded and reads mock registry config. Validation and
            transaction wiring are intentionally deferred.
          </p>
        </Card>
      </div>

      <ConfirmModal
        onClose={() => setOpen(false)}
        onConfirm={() => console.info('Phase C1 create-market stub', { question, seed })}
        open={open}
        title="Launch preview"
      >
        <p>
          No USDC approval or registry transaction will be sent. Your draft stays only in this
          browser session.
        </p>
      </ConfirmModal>
    </main>
  );
}
