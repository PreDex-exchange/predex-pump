import type { HTMLAttributes, ReactNode } from 'react';

import styles from './Card.module.css';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padded?: boolean;
  quiet?: boolean;
  interactive?: boolean;
}

export function Card({
  children,
  padded = true,
  quiet = false,
  interactive = false,
  className = '',
  ...props
}: CardProps) {
  return (
    <div
      className={[
        styles.card,
        padded ? styles.padded : '',
        quiet ? styles.quiet : '',
        interactive ? styles.interactive : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {children}
    </div>
  );
}
