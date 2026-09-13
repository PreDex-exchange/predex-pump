import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('wagmi/connectors', async (importOriginal) => {
  const original = await importOriginal<typeof import('wagmi/connectors')>();
  return {
    ...original,
    // Connector ordering does not need the real MetaMask SDK in jsdom.
    metaMask: () =>
      original.injected({
        target: {
          id: 'metaMaskSDK',
          name: 'MetaMask',
          provider: () => undefined,
        },
      }),
  };
});

async function connectorIds() {
  vi.resetModules();
  const { getWagmiConfig } = await import('./config');
  return getWagmiConfig().connectors.map(({ id }) => id);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('wagmi config Privy gate', () => {
  it('registers no Privy connector without a public App ID', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVY_APP_ID', '');

    const ids = await connectorIds();

    expect(ids[0]).toBe('metaMaskSDK');
    expect(ids).not.toContain('privyEmbedded');
  });

  it('appends the Privy connector after MetaMask when an App ID is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVY_APP_ID', 'test-app-id');

    const ids = await connectorIds();

    expect(ids[0]).toBe('metaMaskSDK');
    expect(ids.filter((id) => id === 'privyEmbedded')).toHaveLength(1);
    expect(ids.indexOf('privyEmbedded')).toBeGreaterThan(
      ids.indexOf('metaMaskSDK'),
    );
  });
});
