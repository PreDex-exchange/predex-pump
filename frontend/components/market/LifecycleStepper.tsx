import type { MarketPhase } from '@predex-pump/shared/domain';

import styles from './LifecycleStepper.module.css';

const STEPS = [
  {
    label: 'Bootstrap',
    description: 'LMSR curve live',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 32 32">
        <path d="M5 25V7M5 25h22" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        <path d="m8 21 5-6 4 3 7-9" fill="none" stroke="#ff6b57" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
      </svg>
    ),
  },
  {
    label: 'Graduated',
    description: 'order book opens',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 32 32">
        <rect fill="#e4f6f0" height="20" rx="4" stroke="currentColor" strokeWidth="2" width="24" x="4" y="6" />
        <path d="M9 12h14M9 16h9M9 20h12" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      </svg>
    ),
  },
  {
    label: 'Resolved',
    description: 'committee settles',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 32 32">
        <circle cx="16" cy="16" fill="#e6f0fb" r="11" stroke="currentColor" strokeWidth="2" />
        <path d="m10 16 4 4 8-9" fill="none" stroke="#17b890" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
      </svg>
    ),
  },
] as const;

function phaseIndex(phase: MarketPhase) {
  if (phase === 'Opened') return 0;
  if (phase === 'Graduated') return 1;
  return 2;
}

export function LifecycleStepper({
  graduated,
  phase,
}: {
  graduated: boolean;
  phase: MarketPhase;
}) {
  const current = phaseIndex(phase);
  const skippedGraduation = current === 2 && !graduated;

  return (
    <ol aria-label="Market lifecycle" className={styles.steps}>
      {STEPS.map((step, index) => {
        const skipped = skippedGraduation && index === 1;
        return (
          <li className={styles.group} key={step.label}>
            <div
              aria-current={index === current ? 'step' : undefined}
              className={`${styles.step} ${
                index < current && !skipped ? styles.done : ''
              } ${index === current ? styles.current : ''} ${
                skipped ? styles.skipped : ''
              }`}
            >
              <span className={styles.icon}>{step.icon}</span>
              <span>
                {skipped ? 'Graduation skipped' : step.label}
                <small>
                  {skipped ? 'settled from incubation' : step.description}
                </small>
              </span>
            </div>
            {index < STEPS.length - 1 && (
              <span
                className={`${styles.line} ${
                  index < current
                    ? skippedGraduation
                      ? styles.lineSkipped
                      : styles.lineDone
                    : ''
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
