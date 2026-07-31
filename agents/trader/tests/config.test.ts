import { describe, expect, it } from 'vitest';

import { loadTraderConfig } from '../src/config.js';

describe('loadTraderConfig', () => {
  it('defaults to dry-run without reading a private key', () => {
    const environment = new Proxy({} as NodeJS.ProcessEnv, {
      get(target, property, receiver) {
        if (property === 'PREDEX_PRIVATE_KEY') {
          throw new Error('private key was read in dry-run');
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const config = loadTraderConfig(environment, []);

    expect(config.dryRun).toBe(true);
    expect(config.traderAddress).toBeUndefined();
    expect('privateKey' in config).toBe(false);
  });

  it('enables send only through an explicit flag or environment opt-in', () => {
    expect(loadTraderConfig({}, ['--send']).dryRun).toBe(false);
    expect(loadTraderConfig({ PREDEX_DRY_RUN: 'false' }, []).dryRun).toBe(false);
  });

  it('parses every hard cap without changing the requested values', () => {
    const config = loadTraderConfig(
      {
        PREDEX_MAX_INVENTORY_PER_SIDE_RAW: '111',
        PREDEX_MAX_NOTIONAL_PER_ORDER_RAW: '222',
        PREDEX_MAX_ORDERS_IN_FLIGHT: '3',
        PREDEX_MAX_SESSION_SPEND_RAW: '444',
      },
      [],
    );

    expect(config.maxInventoryPerSideRaw).toBe(111n);
    expect(config.maxNotionalPerOrderRaw).toBe(222n);
    expect(config.maxOrdersInFlight).toBe(3);
    expect(config.maxSessionSpendRaw).toBe(444n);
  });

  it('rejects an invalid hard cap instead of clamping it', () => {
    expect(() =>
      loadTraderConfig({ PREDEX_MAX_SESSION_SPEND_RAW: '0' }, []),
    ).toThrow(/positive whole number/u);
  });
});
