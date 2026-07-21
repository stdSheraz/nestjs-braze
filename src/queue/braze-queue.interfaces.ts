import { ModuleMetadata } from '@nestjs/common';
import type { ConnectionOptions, JobsOptions } from 'bullmq';

/**
 * Names of the BrazeService methods that can be queued for durable delivery.
 * Read-only exports (`exportUsers`) are included too, though queueing them is
 * unusual — you normally want their return value inline.
 */
export type BrazeQueueableMethod =
  | 'trackUser'
  | 'logEvent'
  | 'logPurchase'
  | 'track'
  | 'identifyAlias'
  | 'createAlias'
  | 'deleteUsers'
  | 'exportUsers'
  | 'triggerCampaign'
  | 'triggerCanvas'
  | 'setEmailSubscription'
  | 'sendMessage'
  | 'sendTransactional'
  | 'setSubscriptionGroup';

/** Shape of a queued job: which BrazeService method to call and with what args. */
export interface BrazeJobData {
  method: BrazeQueueableMethod;
  /** Positional arguments for the method (the trailing options bag is added by the worker). */
  args: unknown[];
}

export interface BrazeQueueModuleOptions {
  /**
   * Redis connection for BullMQ. Accepts an ioredis connection object
   * (`{ host, port, password, ... }`) or a shared ioredis instance.
   */
  connection: ConnectionOptions;
  /**
   * Run the delivery worker in THIS process. Default true. Set false on
   * web/API nodes that should only enqueue, when a dedicated worker process
   * (importing this module with the default) drains the queue.
   */
  runWorker?: boolean;
  /**
   * Override the default BullMQ job options (attempts, backoff, retention).
   * Merged over DEFAULT_BRAZE_JOB_OPTIONS.
   */
  defaultJobOptions?: JobsOptions;
}

export interface BrazeQueueModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => Promise<Omit<BrazeQueueModuleOptions, 'runWorker'>> | Omit<
    BrazeQueueModuleOptions,
    'runWorker'
  >;
  inject?: any[];
  /**
   * Run the delivery worker in this process. Default true. Kept out of the
   * async factory because the module must decide whether to register the
   * worker provider synchronously, at bootstrap.
   */
  runWorker?: boolean;
}
