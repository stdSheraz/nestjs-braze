import { ModuleMetadata } from '@nestjs/common';
import type { ConnectionOptions, JobsOptions } from 'bullmq';
import { BrazeModuleOptions } from '../braze.interfaces';

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

/** Which point in a job's life an entry describes. */
export type BrazeJobLogStage = 'request' | 'response' | 'error';

/** Structured form of one job log line — what a custom `sink` receives. */
export interface BrazeJobLogEntry {
  stage: BrazeJobLogStage;
  /** BrazeService method the job dispatches to. */
  method: string;
  /** BullMQ job id. */
  jobId?: string;
  /** 1-based attempt number for this run. */
  attempt: number;
  /** Max attempts configured for the job, when known. */
  maxAttempts?: number;
  /**
   * The request payload as enqueued (redacted). A single-argument call is
   * unwrapped to the argument itself; multi-argument calls stay an array.
   * Present on every stage, so a failure line is debuggable on its own.
   */
  request?: unknown;
  /** Body Braze returned (redacted). `response` stage only. */
  response?: unknown;
  /** `error` stage only. */
  error?: { message: string; name?: string; stack?: string };
  /** Wall time of the Braze call in ms. `response` and `error` stages. */
  durationMs?: number;
}

/**
 * Request/response logging for queued jobs. Set once on the module and it
 * applies to every job automatically — no per-call wiring.
 */
export interface BrazeJobLoggerOptions {
  /**
   * Defaults to true whenever this object is supplied, so passing any option
   * turns logging on. Set false to keep the config but silence it (handy for
   * flipping it from an env var).
   */
  enabled?: boolean;
  /**
   * Where the lines go. Default `'job'`.
   * - `'job'` — BullMQ's `job.log()`: each job carries its own request/response
   *   body, readable per job in Bull Board / Bull Dashboard ("Logs" tab).
   * - `'logger'` — the Nest logger (stdout), job id included in each line.
   * - `'both'` — both destinations.
   */
  target?: 'job' | 'logger' | 'both';
  /** Log the outgoing payload before the call. Default true. */
  request?: boolean;
  /** Log the body Braze returned. Default true. */
  response?: boolean;
  /** Log failures (the error is rethrown either way, so BullMQ still retries). Default true. */
  errors?: boolean;
  /** Nest logger level, for the `'logger'`/`'both'` targets; failures always use `error`. Default 'log'. */
  level?: 'log' | 'debug' | 'verbose' | 'warn';
  /** Truncate serialised bodies past this many characters. Default 10000; 0 disables truncation. */
  maxBodyLength?: number;
  /**
   * Keys to mask in logged bodies, matched ignoring case and `-`/`_`.
   * Replaces DEFAULT_BRAZE_JOB_LOG_REDACT rather than extending it.
   */
  redact?: string[];
  /**
   * Send entries somewhere of your own (Datadog, Sentry, a request-log table).
   * When set it replaces both built-in destinations — nothing is written to the
   * job log or the Nest logger.
   */
  sink?: (entry: BrazeJobLogEntry) => void;
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
  /**
   * Log every job's request payload and Braze response into the job's own
   * BullMQ log, so you can read them per job in Bull Board / Bull Dashboard.
   * Off by default; `logging: true` enables it with sane defaults, or pass an
   * object to tune destination, redaction, truncation, or a custom sink.
   * Enabling it here is all that's needed — the worker applies it to every job
   * it runs, with no per-call wiring.
   */
  logging?: boolean | BrazeJobLoggerOptions;
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

/**
 * Options for the all-in-one variant that registers the base Braze client
 * (BrazeService) AND the durable queue (BrazeQueueService) from a single call.
 * Use when you want both from one module; do NOT also register BrazeModule
 * separately.
 */
export interface BrazeQueueWithClientOptions
  extends BrazeModuleOptions,
    BrazeQueueModuleOptions {}

export interface BrazeQueueWithClientAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) =>
    | Promise<Omit<BrazeQueueWithClientOptions, 'runWorker'>>
    | Omit<BrazeQueueWithClientOptions, 'runWorker'>;
  inject?: any[];
  /** Run the delivery worker in this process. Default true. Synchronous — see above. */
  runWorker?: boolean;
}
