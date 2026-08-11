'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

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
  const titleId = useId();
  const modalRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);

  useEffect(() => {
    onCloseRef.current = onClose;
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled, onClose]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const modal = modalRef.current;
    modal?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !closeDisabledRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || modal === null) return;

      const focusable = [...modal.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) {
        event.preventDefault();
        modal.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (
        event.shiftKey &&
        (active === first || active === modal || !modal.contains(active))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || active === modal)) {
        event.preventDefault();
        first?.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      onMouseDown={() => {
        if (!closeDisabled) onClose();
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.modal}
        onMouseDown={(event) => event.stopPropagation()}
        ref={modalRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className={styles.kicker}>{kicker}</div>
        <h2 id={titleId}>{title}</h2>
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
