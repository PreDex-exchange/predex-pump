import type { ReactNode } from 'react';

import styles from './Tabs.module.css';

export interface TabOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface TabsProps<T extends string> {
  ariaLabel: string;
  options: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  compact?: boolean;
  className?: string;
}

export function Tabs<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  compact = false,
  className = '',
}: TabsProps<T>) {
  return (
    <div
      aria-label={ariaLabel}
      className={`${styles.tabs} ${compact ? styles.compact : ''} ${className}`}
      role="tablist"
    >
      {options.map((option) => (
        <button
          aria-selected={option.value === value}
          className={`${styles.tab} ${option.value === value ? styles.active : ''}`}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="tab"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
