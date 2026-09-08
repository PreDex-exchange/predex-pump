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
    expect(config.truthMode).toBe('auto');
    expect(config.marketDiscovery).toBe('backend');
    expect('privateKey' in config).toBe(false);
  });

  it('requires an explicit hosted Graph URL and keeps the market query bounded', () => {
    expect(() =>
      loadTraderConfig({ PREDEX_MARKET_DISCOVERY: 'graph-required' }, []),
    ).toThrow(/PREDEX_GRAPH_QUERY_URL/u);

    const config = loadTraderConfig(
      {
        PREDEX_MARKET_DISCOVERY: 'graph-required',
        PREDEX_GRAPH_QUERY_URL:
          'https://api.studio.thegraph.com/query/1758846/predex/0.0.1',
        PREDEX_GRAPH_MARKET_LIMIT: '12',
      },
      [],
    );
    expect(config).toMatchObject({
      marketDiscovery: 'graph-required',
      graphMarketLimit: 12,
      graphQueryUrl:
        'https://api.studio.thegraph.com/query/1758846/predex/0.0.1',
    });
    expect(() =>
      loadTraderConfig(
        {
          PREDEX_MARKET_DISCOVERY: 'graph-required',
          PREDEX_GRAPH_QUERY_URL: 'https://example.com/query',
          PREDEX_GRAPH_MARKET_LIMIT: '21',
        },
        [],
      ),
    ).toThrow(/must not exceed 20/u);
  });

  it('rejects invalid Graph discovery modes and unsafe URLs', () => {
    expect(() =>
      loadTraderConfig({ PREDEX_MARKET_DISCOVERY: 'graph' }, []),
    ).toThrow(/backend or graph-required/u);
    expect(() =>
      loadTraderConfig(
        {
          PREDEX_MARKET_DISCOVERY: 'graph-required',
          PREDEX_GRAPH_QUERY_URL: 'http://example.com/query',
        },
        [],
      ),
    ).toThrow(/HTTPS URL/u);
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

  it('requires an explicit paid truth mode and preserves its payment cap', () => {
    const config = loadTraderConfig(
      {
        PREDEX_TRUTH_MODE: 'paid',
        PREDEX_TRUTH_MAX_PAYMENT_RAW: '77',
      },
      [],
    );

    expect(config.truthMode).toBe('paid');
    expect(config.truthMaxPaymentRaw).toBe(77n);
    expect('privateKey' in config).toBe(false);
  });

  it('accepts explicit World AgentKit truth mode and rejects aliases', () => {
    expect(
      loadTraderConfig({ PREDEX_TRUTH_MODE: 'agentkit' }, []).truthMode,
    ).toBe('agentkit');
    expect(() =>
      loadTraderConfig({ PREDEX_TRUTH_MODE: 'world' }, []),
    ).toThrow(/paid, agentkit, or skip/u);
  });
});
