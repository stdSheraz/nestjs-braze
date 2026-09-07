import { Logger, Optional } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BrazeService } from '../braze.service';
import { BRAZE_QUEUE } from './braze-queue.constants';
import { BrazeJobData } from './braze-queue.interfaces';
import { BrazeJobLogger } from './braze-queue.logger';

/**
 * Drains the Braze queue: for each job it calls the matching BrazeService
 * method with `{ throwOnError: true }` so any failure rejects the job and
 * BullMQ retries it per the configured backoff. That reject-and-retry loop is
 * what turns the swallow-by-default service into at-least-once delivery.
 *
 * When the module's `logging` option is on, every job's request payload and
 * Braze response are written to the job's own BullMQ log around the call, so
 * they're readable per job in Bull Board (see BrazeJobLogger).
 */
@Processor(BRAZE_QUEUE)
export class BrazeQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(BrazeQueueProcessor.name);

  constructor(
    private readonly braze: BrazeService,
    @Optional() private readonly jobLogger?: BrazeJobLogger,
  ) {
    super();
  }

  async process(job: Job<BrazeJobData>): Promise<unknown> {
    const { method, args } = job.data;
    const handler = this.braze[method] as (
      ...a: unknown[]
    ) => Promise<unknown>;

    if (typeof handler !== 'function') {
      // Bad job data — don't retry a call that can never succeed.
      this.logger.error(`Unknown Braze method "${method}" — discarding job ${job.id}`);
      return null;
    }

    // throwOnError so a Braze failure bubbles up and BullMQ retries the job.
    const call = () => handler.call(this.braze, ...args, { throwOnError: true });

    if (!this.jobLogger?.enabled) return call();

    await this.jobLogger.logRequest(job);
    const startedAt = Date.now();
    try {
      const response = await call();
      await this.jobLogger.logResponse(job, response, Date.now() - startedAt);
      return response;
    } catch (error) {
      await this.jobLogger.logError(job, error, Date.now() - startedAt);
      throw error; // still rethrown, so retry behaviour is unchanged
    }
  }
}
