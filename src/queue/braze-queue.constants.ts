import type { JobsOptions } from 'bullmq';

/** BullMQ queue name used for durable Braze delivery. */
export const BRAZE_QUEUE = 'braze';

/** DI token holding the resolved BrazeQueueModuleOptions. */
export const BRAZE_QUEUE_OPTIONS = Symbol('BRAZE_QUEUE_OPTIONS');

/**
 * Retry defaults that make delivery durable: a job that fails (Braze 5xx,
 * timeout, network blip) is retried with exponential backoff. Failed jobs are
 * kept in Redis for inspection / manual retry rather than silently discarded.
 * Callers can override any of these per-call or per-module.
 */
export const DEFAULT_BRAZE_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

/**
 * Keys masked by default in logged request/response bodies. Matching ignores
 * case and `-`/`_`, so `api_key`, `apiKey` and `API-KEY` are all covered.
 * Braze payloads are mostly PII by nature — add `email`, `phone`, etc. via
 * `logging.redact` if your log sink shouldn't see them.
 */
export const DEFAULT_BRAZE_JOB_LOG_REDACT = [
  'apikey',
  'authorization',
  'password',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'credentials',
];

/** Logged bodies are truncated past this many characters. */
export const DEFAULT_BRAZE_JOB_LOG_MAX_BODY_LENGTH = 10_000;
