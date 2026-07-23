'use client';

import { useEffect, type ReactNode } from 'react';

import { Button } from './Button';
import styles from './ConfirmModal.module.css';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm?: () => void;
}

export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel = 'Got it',
  onClose,
  onConfirm,
}: ConfirmModalProps) {
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        aria-labelledby="confirm-title"
        aria-modal="true"
        className={styles.modal}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className={styles.kicker}>Preview mode</div>
        <h2 id="confirm-title">{title}</h2>
        <div className={styles.body}>{children}</div>
        <div className={styles.actions}>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            onClick={() => {
              onConfirm?.();
              onClose();
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
