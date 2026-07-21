import 'reflect-metadata';
import { DEFAULT_BRAZE_JOB_OPTIONS } from '../src/queue/braze-queue.constants';
import { BrazeQueueModule } from '../src/queue/braze-queue.module';
import { BrazeQueueProcessor } from '../src/queue/braze-queue.processor';
import { BrazeQueueService } from '../src/queue/braze-queue.service';

describe('BrazeQueueService (producer)', () => {
  function build(defaultJobOptions?: any) {
    const add = jest.fn().mockResolvedValue({ id: '1' });
    const queue = { add } as any;
    const service = new BrazeQueueService(queue, {
      connection: {} as any,
      defaultJobOptions,
    });
    return { service, add };
  }

  it('enqueues trackUser as method+args with default retry options', async () => {
    const { service, add } = build();
    await service.trackUser({ external_id: 'u1', plan: 'premium' });

    expect(add).toHaveBeenCalledWith(
      'trackUser',
      { method: 'trackUser', args: [{ external_id: 'u1', plan: 'premium' }] },
      expect.objectContaining({
        attempts: DEFAULT_BRAZE_JOB_OPTIONS.attempts,
        backoff: DEFAULT_BRAZE_JOB_OPTIONS.backoff,
      }),
    );
  });

  it('flattens multi-argument methods into the args array', async () => {
    const { service, add } = build();
    await service.setSubscriptionGroup('g1', 'subscribed', ['u1', 'u2']);
    expect(add.mock.calls[0][1]).toEqual({
      method: 'setSubscriptionGroup',
      args: ['g1', 'subscribed', ['u1', 'u2']],
    });
  });

  it('merges per-call job options over module defaults over built-in defaults', async () => {
    const { service, add } = build({ attempts: 9 });
    await service.logEvent({ external_id: 'u1', name: 'x' }, { priority: 1 });

    const opts = add.mock.calls[0][2];
    expect(opts.attempts).toBe(9); // module default wins over built-in 5
    expect(opts.priority).toBe(1); // per-call option applied
  });
});

describe('BrazeQueueProcessor (worker)', () => {
  function build() {
    const braze: any = {
      trackUser: jest.fn().mockResolvedValue({ message: 'success' }),
      setSubscriptionGroup: jest.fn().mockResolvedValue({ message: 'success' }),
    };
    return { processor: new BrazeQueueProcessor(braze), braze };
  }

  it('dispatches to the matching BrazeService method with throwOnError', async () => {
    const { processor, braze } = build();
    await processor.process({
      data: { method: 'trackUser', args: [{ external_id: 'u1' }] },
    } as any);

    expect(braze.trackUser).toHaveBeenCalledWith(
      { external_id: 'u1' },
      { throwOnError: true },
    );
  });

  it('spreads multi-arg calls and appends throwOnError last', async () => {
    const { processor, braze } = build();
    await processor.process({
      data: { method: 'setSubscriptionGroup', args: ['g1', 'subscribed', ['u1']] },
    } as any);

    expect(braze.setSubscriptionGroup).toHaveBeenCalledWith(
      'g1',
      'subscribed',
      ['u1'],
      { throwOnError: true },
    );
  });

  it('discards jobs with an unknown method instead of retrying forever', async () => {
    const { processor } = build();
    const result = await processor.process({
      id: 'j1',
      data: { method: 'nope', args: [] },
    } as any);
    expect(result).toBeNull();
  });

  it('propagates errors so BullMQ retries the job', async () => {
    const braze: any = {
      trackUser: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const processor = new BrazeQueueProcessor(braze);
    await expect(
      processor.process({ data: { method: 'trackUser', args: [{}] } } as any),
    ).rejects.toThrow('boom');
  });
});

describe('BrazeQueueModule.forRootWithClient (single-module setup)', () => {
  it('registers both the client (BrazeModule) and the queue, exports BrazeQueueService', () => {
    const mod = BrazeQueueModule.forRootWithClient({
      endpoint: 'https://rest.iad-01.braze.com',
      apiKey: 'k',
      connection: { host: 'localhost', port: 6379 },
    });

    expect(mod.imports).toHaveLength(2); // BrazeModule + BullModule queue
    expect(mod.exports).toContain(BrazeQueueService);
    expect(mod.providers).toContain(BrazeQueueProcessor); // worker on by default
  });

  it('omits the worker provider when runWorker is false', () => {
    const mod = BrazeQueueModule.forRootWithClient({
      endpoint: 'https://rest.iad-01.braze.com',
      apiKey: 'k',
      connection: { host: 'localhost', port: 6379 },
      runWorker: false,
    });
    expect(mod.providers).not.toContain(BrazeQueueProcessor);
    expect(mod.providers).toContain(BrazeQueueService); // producer still there
  });
});
