import type { ButtonHTMLAttributes, ReactNode } from 'react';

import styles from './Button.module.css';

export type ButtonVariant = 'coral' | 'mint' | 'sky' | 'neutral' | 'ghost';
export type ButtonSize = 'small' | 'medium' | 'large';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

export function buttonClassName(
  variant: ButtonVariant = 'neutral',
  size: ButtonSize = 'medium',
  fullWidth = false,
) {
  return [
    styles.button,
    styles[variant],
    styles[size],
    fullWidth ? styles.fullWidth : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function Button({
  children,
  variant = 'neutral',
  size = 'medium',
  fullWidth = false,
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${buttonClassName(variant, size, fullWidth)} ${className}`}
      type={type}
      {...props}
    >
      {children}
    </button>
  );
}
