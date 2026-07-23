import type { MarketPhase, Outcome } from '@predex-pump/shared/domain';
import type { ReactNode } from 'react';

import { phaseLabel } from '@/lib/format';

import styles from './Badge.module.css';

type BadgeTone = 'incubating' | 'graduated' | 'resolved' | 'closed' | 'yes' | 'no' | 'neutral';

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}

export function Badge({ children, tone = 'neutral', className = '' }: BadgeProps) {
  return <span className={`${styles.badge} ${styles[tone]} ${className}`}>{children}</span>;
}

export function PhaseBadge({
  phase,
  surface = 'detail',
}: {
  phase: MarketPhase;
  surface?: 'detail' | 'feed';
}) {
  const tone: BadgeTone =
    phase === 'Opened'
      ? 'incubating'
      : phase === 'Graduated'
        ? 'graduated'
        : phase === 'ClosedOut'
          ? 'closed'
          : 'resolved';

  return (
    <Badge
      className={phase === 'Opened' && surface === 'feed' ? styles.incubatingFeed : ''}
      tone={tone}
    >
      <span aria-hidden="true">{phase === 'Opened' ? '◌' : phase === 'Graduated' ? '✦' : '✓'}</span>
      {phaseLabel(phase)}
    </Badge>
  );
}

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  return <Badge tone={outcome === 'YES' ? 'yes' : 'no'}>{outcome}</Badge>;
}
