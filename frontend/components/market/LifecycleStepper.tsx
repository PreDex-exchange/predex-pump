import type { MarketPhase } from '@predex-pump/shared/domain';

import styles from './LifecycleStepper.module.css';

const STEPS = [
  {
    label: 'Incubating',
    description: 'bonding curve · egg cracking',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 32 32">
        <path d="M16 3C9 3 6 12 6 19c0 7 4 11 10 11s10-4 10-11C26 12 23 3 16 3Z" fill="#ffc24b" stroke="currentColor" strokeWidth="2" />
        <path d="m8 17 5-4 4 5 5-5 3 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      </svg>
    ),
  },
  {
    label: 'Graduated',
    description: 'order book opens',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 32 32">
        <circle cx="16" cy="15" fill="#ffc24b" r="9" stroke="currentColor" strokeWidth="2" />
        <circle cx="13" cy="14" fill="currentColor" r="1.4" />
        <circle cx="19" cy="14" fill="currentColor" r="1.4" />
        <path d="m14 17 4 0-2 3z" fill="#ff6b57" stroke="currentColor" strokeLinejoin="round" strokeWidth="1" />
        <path d="M7 22 11 19l5 4 5-4 4 3c-2 5-16 5-18 0Z" fill="#fff" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
      </svg>
    ),
  },
  {
    label: 'Resolved',
    description: 'committee settles',
    icon: (
      <svg aria-hidden="true" viewBox="0 0 32 32">
        <path d="M7 20c6 1 10-3 12-9 1 5 3 7 7 8-4 2-8 5-10 9-1-4-4-6-9-8Z" fill="#e6f0fb" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
        <path d="m5 25 6-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      </svg>
    ),
  },
] as const;

function phaseIndex(phase: MarketPhase) {
  if (phase === 'Opened') return 0;
  if (phase === 'Graduated') return 1;
  return 2;
}

export function LifecycleStepper({ phase }: { phase: MarketPhase }) {
  const current = phaseIndex(phase);

  return (
    <ol aria-label="Market lifecycle" className={styles.steps}>
      {STEPS.map((step, index) => (
        <li className={styles.group} key={step.label}>
          <div
            aria-current={index === current ? 'step' : undefined}
            className={`${styles.step} ${index < current ? styles.done : ''} ${index === current ? styles.current : ''}`}
          >
            <span className={styles.icon}>{step.icon}</span>
            <span>
              {step.label}
              <small>{step.description}</small>
            </span>
          </div>
          {index < STEPS.length - 1 && (
            <span className={`${styles.line} ${index < current ? styles.lineDone : ''}`} />
          )}
        </li>
      ))}
    </ol>
  );
}
