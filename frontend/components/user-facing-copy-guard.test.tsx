import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { internalIdentifiersInRenderedOutput } from './market/user-facing-copy.test-utils';
import {
  internalIdentifiersInTsxSource,
  userFacingCopyViolations,
} from '../scripts/user-facing-copy-guard.mjs';

describe('user-facing copy guard', () => {
  it('rejects identifiers in prose while allowing product terms and code samples', () => {
    const rendered = render(
      <div>
        <p>Do not expose createMarket or MarketCreated in prose.</p>
        <p>
          MetaMask, MiniCLOB, PnL, USDC, and LMSR are legitimate product terms.
          A genuine sample such as <code>claimFundingResidual</code> is code.
        </p>
      </div>,
    );

    expect(internalIdentifiersInRenderedOutput(rendered.container)).toEqual([
      'MarketCreated',
      'createMarket',
    ]);
  });

  it('applies the same rule statically while excluding genuine code elements', () => {
    const violations = internalIdentifiersInTsxSource(`
      export function Fixture() {
        return (
          <div>
            <p>Do not expose createMarket in prose.</p>
            <p>MetaMask, MiniCLOB, PnL, USDC, and LMSR remain allowed.</p>
            <code>MarketCreated and claimFundingResidual</code>
          </div>
        );
      }
    `);

    expect(violations.flatMap(({ identifiers }) => identifiers)).toEqual([
      'createMarket',
    ]);
  });

  it('scans every production component and app route', () => {
    expect(userFacingCopyViolations(process.cwd())).toEqual([]);
  });
});
