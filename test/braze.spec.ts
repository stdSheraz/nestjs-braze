import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { BrazeModule } from '../src/braze.module';
import { BrazeService } from '../src/braze.service';
import { BRAZE_CLIENT } from '../src/braze.constants';

describe('BrazeModule', () => {
  it('resolves BrazeService via forRoot', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        BrazeModule.forRoot({
          endpoint: 'https://rest.iad-01.braze.com',
          apiKey: 'test-key',
          enabled: false,
        }),
      ],
    }).compile();

    expect(mod.get(BrazeService)).toBeInstanceOf(BrazeService);
  });

  it('resolves BrazeService via forRootAsync', async () => {
    const mod = await Test.createTestingModule({
      imports: [
        BrazeModule.forRootAsync({
          useFactory: () => ({
            endpoint: 'https://rest.iad-01.braze.com',
            apiKey: 'test-key',
            enabled: false,
          }),
        }),
      ],
    }).compile();

    expect(mod.get(BrazeService)).toBeInstanceOf(BrazeService);
  });
});

describe('BrazeService', () => {
  async function buildService(overrides?: {
    enabled?: boolean;
    track?: jest.Mock;
  }) {
    const track = overrides?.track ?? jest.fn().mockResolvedValue({ message: 'success' });
    const fakeClient = {
      users: {
        track,
        identify: jest.fn().mockResolvedValue({ message: 'success' }),
        delete: jest.fn().mockResolvedValue({ message: 'success' }),
        alias: { new: jest.fn().mockResolvedValue({ message: 'success' }) },
        export: { ids: jest.fn().mockResolvedValue({ users: [] }) },
      },
      campaigns: { trigger: { send: jest.fn().mockResolvedValue({ message: 'success' }) } },
      canvas: { trigger: { send: jest.fn().mockResolvedValue({ message: 'success' }) } },
      messages: { send: jest.fn().mockResolvedValue({ message: 'success' }) },
      subscription: { status: { set: jest.fn().mockResolvedValue({ message: 'success' }) } },
      transactional: { v1: { campaigns: { send: jest.fn().mockResolvedValue({ message: 'success' }) } } },
    };

    const mod = await Test.createTestingModule({
      imports: [
        BrazeModule.forRoot({
          endpoint: 'https://rest.iad-01.braze.com',
          apiKey: 'test-key',
          enabled: overrides?.enabled ?? true,
        }),
      ],
    })
      .overrideProvider(BRAZE_CLIENT)
      .useValue(fakeClient)
      .compile();

    return { service: mod.get(BrazeService), client: fakeClient, track };
  }

  it('trackUser calls users.track with attributes', async () => {
    const { service, track } = await buildService();
    await service.trackUser({ external_id: 'u1', plan: 'premium' });
    expect(track).toHaveBeenCalledWith({
      attributes: [{ external_id: 'u1', plan: 'premium' }],
    });
  });

  it('logEvent stamps time automatically', async () => {
    const { service, track } = await buildService();
    await service.logEvent({ external_id: 'u1', name: 'signup' });
    const payload = track.mock.calls[0][0];
    expect(payload.events[0].name).toBe('signup');
    expect(payload.events[0].time).toBeDefined();
  });

  it('logPurchase defaults quantity to 1', async () => {
    const { service, track } = await buildService();
    await service.logPurchase({
      external_id: 'u1',
      product_id: 'sku',
      currency: 'USD',
      price: 9.99,
    });
    expect(track.mock.calls[0][0].purchases[0].quantity).toBe(1);
  });

  it('track chunks payloads to 75 objects per request', async () => {
    const { service, track } = await buildService();
    await service.track({
      attributes: Array.from({ length: 160 }, (_, i) => ({ external_id: `u${i}` })),
    });
    expect(track).toHaveBeenCalledTimes(3);
    expect(track.mock.calls[0][0].attributes).toHaveLength(75);
    expect(track.mock.calls[2][0].attributes).toHaveLength(10);
  });

  it('no-ops when disabled', async () => {
    const { service, track } = await buildService({ enabled: false });
    const result = await service.trackUser({ external_id: 'u1' });
    expect(result).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it('swallows errors by default', async () => {
    const { service } = await buildService({
      track: jest.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(service.trackUser({ external_id: 'u1' })).resolves.toBeNull();
  });

  it('throws when throwOnError is set', async () => {
    const { service } = await buildService({
      track: jest.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(
      service.trackUser({ external_id: 'u1' }, { throwOnError: true }),
    ).rejects.toThrow('boom');
  });

  it('fireAndForget resolves to null immediately but still fires the request', async () => {
    let resolveTrack!: (v: unknown) => void;
    const track = jest.fn(
      () => new Promise((resolve) => (resolveTrack = resolve)),
    );
    const { service } = await buildService({ track });

    const result = await service.trackUser(
      { external_id: 'u1' },
      { fireAndForget: true },
    );

    expect(result).toBeNull(); // returned before the HTTP call resolved
    expect(track).toHaveBeenCalledTimes(1); // but the request was kicked off
    resolveTrack({ message: 'success' });
  });

  it('fireAndForget never throws, even with throwOnError set', async () => {
    const { service } = await buildService({
      track: jest.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(
      service.trackUser(
        { external_id: 'u1' },
        { fireAndForget: true, throwOnError: true },
      ),
    ).resolves.toBeNull();
  });

  it('triggerCampaign forwards payload', async () => {
    const { service, client } = await buildService();
    await service.triggerCampaign({ campaign_id: 'c1', broadcast: true });
    expect(client.campaigns.trigger.send).toHaveBeenCalledWith({
      campaign_id: 'c1',
      broadcast: true,
    });
  });

  it('setSubscriptionGroup forwards ids and state', async () => {
    const { service, client } = await buildService();
    await service.setSubscriptionGroup('g1', 'subscribed', ['u1', 'u2']);
    expect(client.subscription.status.set).toHaveBeenCalledWith({
      subscription_group_id: 'g1',
      subscription_state: 'subscribed',
      external_id: ['u1', 'u2'],
    });
  });
});

describe('logOrderPlaced (eCommerce recommended event)', () => {
  function build() {
    const track = jest.fn().mockResolvedValue({ message: 'success' });
    const braze: any = { users: { track } };
    const service = new BrazeService(
      { endpoint: 'e', apiKey: 'k', enabled: true } as any,
      braze,
    );
    return { service, track };
  }

  const order = {
    external_id: 'u1',
    order_id: 'trip_123',
    total_value: 42.5,
    currency: 'QAR',
    source: 'backend',
    products: [
      {
        product_id: 'economy',
        product_name: 'Economy ride',
        variant_id: 'economy',
        quantity: 1,
        price: 42.5,
      },
    ],
  };

  it('sends an event, never the disabled purchases array', async () => {
    const { service, track } = build();
    await service.logOrderPlaced(order);

    const body = track.mock.calls[0][0];
    expect(body.purchases).toBeUndefined(); // the whole point of the migration
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe('ecommerce.order_placed');
    expect(body.events[0].external_id).toBe('u1');
  });

  it('puts the order fields in properties and keeps routing fields out of them', async () => {
    const { service, track } = build();
    await service.logOrderPlaced(order);

    const props = track.mock.calls[0][0].events[0].properties;
    expect(props).toEqual({
      order_id: 'trip_123',
      total_value: 42.5,
      currency: 'QAR',
      source: 'backend',
      products: order.products,
    });
    // external_id / time address the event, they aren't order properties
    expect(props.external_id).toBeUndefined();
    expect(props.time).toBeUndefined();
  });

  it('defaults time to now, and does not let an absent time blank it', async () => {
    const { service, track } = build();
    await service.logOrderPlaced({ ...order, time: undefined });

    const time = track.mock.calls[0][0].events[0].time;
    expect(typeof time).toBe('string');
    expect(Number.isNaN(Date.parse(time))).toBe(false);
  });

  it('honours an explicit time', async () => {
    const { service, track } = build();
    await service.logOrderPlaced({ ...order, time: '2026-01-01T00:00:00.000Z' });
    expect(track.mock.calls[0][0].events[0].time).toBe('2026-01-01T00:00:00.000Z');
  });
});
