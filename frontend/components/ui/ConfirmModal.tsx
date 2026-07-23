'use client';

import { useEffect, type ReactNode } from 'react';

import { Button } from './Button';
import styles from './ConfirmModal.module.css';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  closeDisabled?: boolean;
  closeOnConfirm?: boolean;
  kicker?: string;
  onClose: () => void;
  onConfirm?: () => void | Promise<void>;
}

export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel = 'Got it',
  confirmDisabled = false,
  closeDisabled = false,
  closeOnConfirm = true,
  kicker = 'Preview mode',
  onClose,
  onConfirm,
}: ConfirmModalProps) {
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !closeDisabled) onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeDisabled, onClose, open]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      onMouseDown={() => {
        if (!closeDisabled) onClose();
      }}
    >
      <div
        aria-labelledby="confirm-title"
        aria-modal="true"
        className={styles.modal}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className={styles.kicker}>{kicker}</div>
        <h2 id="confirm-title">{title}</h2>
        <div className={styles.body}>{children}</div>
        <div className={styles.actions}>
          <Button disabled={closeDisabled} onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={confirmDisabled}
            onClick={() => {
              void onConfirm?.();
              if (closeOnConfirm) onClose();
            }}
            variant="coral"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
