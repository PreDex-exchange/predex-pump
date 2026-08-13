import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StatePanel } from './StatePanel';
import styles from './StatePanel.module.css';

afterEach(cleanup);

describe('StatePanel mascot control', () => {
  it('fails safe without a mascot when the caller passes no preference', () => {
    const rendered = render(
      <StatePanel message="Nothing here yet." state="empty" title="Empty state" />,
    );
    expect(rendered.container.querySelector('svg')).toBeNull();
  });

  it('lets a non-money surface opt in to the mascot', () => {
    const rendered = render(
      <StatePanel
        message="Nothing here yet."
        showMascot
        state="empty"
        title="Empty state"
      />,
    );
    const panel = rendered.container.firstElementChild as HTMLElement;
    expect(rendered.container.querySelector('svg')).not.toBeNull();
    expect(panel.classList.contains(styles.withoutMascot)).toBe(false);
    expect(panel.querySelector(`.${styles.content}`)).not.toBeNull();
  });

  it('announces errors assertively without treating empty states as failures', () => {
    const rendered = render(
      <StatePanel message="The request failed." state="error" title="Unavailable" />,
    );

    expect(screen.getByRole('alert').textContent).toContain('The request failed.');
    rendered.rerender(
      <StatePanel message="Nothing here yet." state="empty" title="Empty state" />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces loading states politely', () => {
    render(
      <StatePanel message="Loading the request." state="loading" title="Loading" />,
    );

    expect(screen.getByRole('status').textContent).toContain('Loading the request.');
  });
});
