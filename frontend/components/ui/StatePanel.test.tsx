import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StatePanel } from './StatePanel';
import styles from './StatePanel.module.css';

afterEach(cleanup);

describe('StatePanel mascot control', () => {
  it('fails safe without a mascot when the caller passes no preference', () => {
    const rendered = render(
      <StatePanel message="Nothing here yet." title="Empty state" />,
    );
    expect(rendered.container.querySelector('svg')).toBeNull();
  });

  it('lets a non-money surface opt in to the mascot', () => {
    const rendered = render(
      <StatePanel
        message="Nothing here yet."
        showMascot
        title="Empty state"
      />,
    );
    const panel = rendered.container.firstElementChild as HTMLElement;
    expect(rendered.container.querySelector('svg')).not.toBeNull();
    expect(panel.classList.contains(styles.withoutMascot)).toBe(false);
    expect(panel.querySelector(`.${styles.content}`)).not.toBeNull();
  });
});
