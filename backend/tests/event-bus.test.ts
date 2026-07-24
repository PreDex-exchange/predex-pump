import type { ServerEvent } from '@predex-pump/shared';
import { describe, expect, it, vi } from 'vitest';

import { ServerEventBus } from '../src/events/bus.js';

function priceTick(channel: `market:${string}`): ServerEvent {
  return {
    channel,
    event: 'price.tick',
    data: {
      marketId: channel.slice('market:'.length),
      yesPriceRaw: '500000',
      noPriceRaw: '500000',
      ts: 1_700_000_000,
    },
  };
}

describe('ServerEventBus channel fan-out', () => {
  it('touches only listeners registered for the published channel', () => {
    const bus = new ServerEventBus();
    const matching = vi.fn();
    const unrelated = vi.fn();
    const unsubscribe = bus.subscribe('market:1', matching);
    bus.subscribe('market:2', unrelated);

    expect(bus.hasSubscribers('market:1')).toBe(true);
    expect(bus.subscribedChannels('account:')).toEqual([]);
    bus.publish(priceTick('market:1'), 1_700_000_000);
    expect(matching).toHaveBeenCalledOnce();
    expect(unrelated).not.toHaveBeenCalled();

    unsubscribe();
    expect(bus.hasSubscribers('market:1')).toBe(false);
    bus.publish(priceTick('market:1'), 1_700_000_001);
    expect(matching).toHaveBeenCalledOnce();
  });
});
