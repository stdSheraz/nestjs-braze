import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BrazeService } from '../braze.service';
import { BRAZE_QUEUE } from './braze-queue.constants';
import { BrazeJobData } from './braze-queue.interfaces';

/**
 * Drains the Braze queue: for each job it calls the matching BrazeService
 * method with `{ throwOnError: true }` so any failure rejects the job and
 * BullMQ retries it per the configured backoff. That reject-and-retry loop is
 * what turns the swallow-by-default service into at-least-once delivery.
 */
@Processor(BRAZE_QUEUE)
export class BrazeQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(BrazeQueueProcessor.name);

  constructor(private readonly braze: BrazeService) {
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
    return handler.call(this.braze, ...args, { throwOnError: true });
  }
}
