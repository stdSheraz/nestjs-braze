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
