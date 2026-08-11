import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfirmModal } from './ConfirmModal';

afterEach(cleanup);

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open review
      </button>
      <ConfirmModal
        confirmLabel="Approve"
        onClose={() => setOpen(false)}
        open={open}
        title="Review"
      >
        <p>Review details</p>
      </ConfirmModal>
    </>
  );
}

describe('ConfirmModal accessibility and viewport behavior', () => {
  it('moves focus into the dialog, traps Tab, and restores trigger focus', async () => {
    render(<ModalHarness />);
    const trigger = screen.getByRole('button', { name: 'Open review' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const approve = within(dialog).getByRole('button', { name: 'Approve' });
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(approve);

    dialog.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    approve.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    cancel.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(approve);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps content scrollable and actions outside the scrolling body', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'components/ui/ConfirmModal.module.css'),
      'utf8',
    );

    expect(css).toMatch(/\.modal\s*\{[^}]*max-height:\s*calc\(100dvh/su);
    expect(css).toMatch(/\.body\s*\{[^}]*overflow-y:\s*auto/su);
    expect(css).toMatch(/\.actions\s*\{[^}]*flex-shrink:\s*0/su);
  });
});
