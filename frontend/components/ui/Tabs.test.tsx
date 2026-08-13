import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Tabs } from './Tabs';

const options = [
  { value: '1h', label: '1H' },
  { value: '1d', label: '1D' },
  { value: 'all', label: 'All' },
] as const;

function ToggleTabs() {
  const [value, setValue] = useState<(typeof options)[number]['value']>('1d');
  return (
    <Tabs
      ariaLabel="Chart timeframe"
      onChange={setValue}
      options={options}
      value={value}
    />
  );
}

afterEach(cleanup);

describe('Tabs semantics', () => {
  it('exposes an accurately labelled toggle group instead of an incomplete tabs pattern', () => {
    render(<ToggleTabs />);

    expect(screen.getByRole('group', { name: 'Chart timeframe' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toEqual([]);

    const oneDay = screen.getByRole('button', { name: '1D' });
    const all = screen.getByRole('button', { name: 'All' });
    expect(oneDay.getAttribute('aria-pressed')).toBe('true');
    expect(all.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(all);
    expect(oneDay.getAttribute('aria-pressed')).toBe('false');
    expect(all.getAttribute('aria-pressed')).toBe('true');
  });
});
