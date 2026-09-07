import 'reflect-metadata';
import { DEFAULT_BRAZE_JOB_OPTIONS } from '../src/queue/braze-queue.constants';
import { BrazeJobLogger } from '../src/queue/braze-queue.logger';
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

  it('logs request + response into the job log when logging is enabled', async () => {
    const { braze } = build();
    const processor = new BrazeQueueProcessor(
      braze,
      new BrazeJobLogger({ connection: {} as any, logging: true }),
    );
    const log = jest.fn().mockResolvedValue(1);

    await processor.process({
      id: '9',
      data: { method: 'trackUser', args: [{ external_id: 'u1' }] },
      attemptsMade: 0,
      opts: { attempts: 5 },
      log,
    } as any);

    const rows: string[] = log.mock.calls.map((c: any[]) => c[0]);
    expect(rows[0]).toContain('request {"external_id":"u1"}');
    expect(rows[1]).toContain('response (ok in');
    expect(rows[1]).toContain('{"message":"success"}');
  });

  it('logs the failure to the job log and still rethrows for the retry', async () => {
    const braze: any = {
      trackUser: jest.fn().mockRejectedValue(new Error('braze 503')),
    };
    const processor = new BrazeQueueProcessor(
      braze,
      new BrazeJobLogger({ connection: {} as any, logging: true }),
    );
    const log = jest.fn().mockResolvedValue(1);

    await expect(
      processor.process({
        id: '9',
        data: { method: 'trackUser', args: [{ external_id: 'u1' }] },
        attemptsMade: 0,
        opts: { attempts: 5 },
        log,
      } as any),
    ).rejects.toThrow('braze 503');

    expect(log.mock.calls[1][0]).toContain('failed in');
  });

  it('does not touch the job log when logging is off', async () => {
    const { braze } = build();
    const processor = new BrazeQueueProcessor(
      braze,
      new BrazeJobLogger({ connection: {} as any }),
    );
    const log = jest.fn();

    await processor.process({
      data: { method: 'trackUser', args: [{ external_id: 'u1' }] },
      log,
    } as any);

    expect(log).not.toHaveBeenCalled();
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
    expect(mod.providers).not.toContain(BrazeJobLogger); // logger is worker-side
    expect(mod.providers).toContain(BrazeQueueService); // producer still there
  });
});

describe('BrazeJobLogger (job.log request/response)', () => {
  function makeJob(overrides: any = {}) {
    return {
      id: '7',
      data: { method: 'trackUser', args: [{ external_id: 'u1' }] },
      attemptsMade: 0,
      opts: { attempts: 5 },
      log: jest.fn().mockResolvedValue(1),
      ...overrides,
    };
  }

  it('is off unless the module opts in', () => {
    expect(new BrazeJobLogger(undefined).enabled).toBe(false);
    expect(new BrazeJobLogger({ connection: {} as any }).enabled).toBe(false);
  });

  it('auto-enables for every job from a single `logging: true`', () => {
    const logger = new BrazeJobLogger({ connection: {} as any, logging: true });
    expect(logger.enabled).toBe(true);
  });

  it('treats any logging object as enabled, and honours enabled:false', () => {
    const opts = { connection: {} as any };
    expect(new BrazeJobLogger({ ...opts, logging: { level: 'debug' } }).enabled).toBe(true);
    expect(new BrazeJobLogger({ ...opts, logging: { enabled: false } }).enabled).toBe(false);
  });

  it('writes request and response bodies to the job log for Bull Board', async () => {
    const logger = new BrazeJobLogger({ connection: {} as any, logging: true });
    const job = makeJob();

    await logger.logRequest(job as any);
    await logger.logResponse(job as any, { message: 'success' }, 120);

    const rows: string[] = job.log.mock.calls.map((c: any[]) => c[0]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('trackUser attempt=1/5');
    expect(rows[0]).toContain('request {"external_id":"u1"}');
    expect(rows[1]).toContain('response (ok in 120ms) {"message":"success"}');
  });

  it('logs the request payload alongside a failure so the job is self-contained', async () => {
    const logger = new BrazeJobLogger({ connection: {} as any, logging: true });
    const job = makeJob({ attemptsMade: 2 });

    await logger.logError(job as any, new Error('braze 503'), 40);

    const row: string = job.log.mock.calls[0][0];
    expect(row).toContain('attempt=3/5');
    expect(row).toContain('failed in 40ms: braze 503');
    expect(row).toContain('request {"external_id":"u1"}');
  });

  it('masks secret-ish keys regardless of case or separators', async () => {
    const logger = new BrazeJobLogger({ connection: {} as any, logging: true });
    const job = makeJob({
      data: {
        method: 'trackUser',
        args: [{ external_id: 'u1', api_key: 'k', nested: { Authorization: 'Bearer x' } }],
      },
    });

    await logger.logRequest(job as any);

    const row: string = job.log.mock.calls[0][0];
    expect(row).not.toContain('Bearer x');
    expect(row).toContain('"api_key":"[redacted]"');
    expect(row).toContain('"Authorization":"[redacted]"');
    expect(row).toContain('"external_id":"u1"'); // non-secret fields survive
  });

  it('truncates oversized bodies', async () => {
    const logger = new BrazeJobLogger({
      connection: {} as any,
      logging: { maxBodyLength: 20 },
    });
    const job = makeJob({
      data: { method: 'trackUser', args: [{ external_id: 'x'.repeat(500) }] },
    });

    await logger.logRequest(job as any);
    expect(job.log.mock.calls[0][0]).toContain('truncated');
  });

  it('never lets a job-log write failure break delivery', async () => {
    const logger = new BrazeJobLogger({ connection: {} as any, logging: true });
    const job = makeJob({ log: jest.fn().mockRejectedValue(new Error('redis down')) });
    await expect(logger.logRequest(job as any)).resolves.toBeUndefined();
  });

  it('skips the job log when target is the Nest logger only', async () => {
    const logger = new BrazeJobLogger({
      connection: {} as any,
      logging: { target: 'logger' },
    });
    const job = makeJob();
    await logger.logRequest(job as any);
    expect(job.log).not.toHaveBeenCalled();
  });

  it('routes structured entries to a custom sink instead of both destinations', async () => {
    const sink = jest.fn();
    const logger = new BrazeJobLogger({ connection: {} as any, logging: { sink } });
    const job = makeJob();

    await logger.logResponse(job as any, { message: 'success' }, 15);

    expect(job.log).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'response',
        method: 'trackUser',
        jobId: '7',
        attempt: 1,
        maxAttempts: 5,
        request: { external_id: 'u1' },
        response: { message: 'success' },
        durationMs: 15,
      }),
    );
  });
});
