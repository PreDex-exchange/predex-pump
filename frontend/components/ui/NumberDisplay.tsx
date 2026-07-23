import type { HTMLAttributes, ReactNode } from 'react';

import styles from './NumberDisplay.module.css';

interface NumberDisplayProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  size?: 'small' | 'body' | 'price' | 'hero';
  tone?: 'default' | 'yes' | 'no' | 'muted' | 'error';
}

export function NumberDisplay({
  children,
  size = 'body',
  tone = 'default',
  className = '',
  ...props
}: NumberDisplayProps) {
  return (
    <span className={`${styles.number} ${styles[size]} ${styles[tone]} ${className}`} {...props}>
      {children}
    </span>
  );
}
