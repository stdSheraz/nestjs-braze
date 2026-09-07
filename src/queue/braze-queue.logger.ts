import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Job } from 'bullmq';
import { extractBrazeError } from '../braze.errors';
import {
  BRAZE_QUEUE_OPTIONS,
  DEFAULT_BRAZE_JOB_LOG_MAX_BODY_LENGTH,
  DEFAULT_BRAZE_JOB_LOG_REDACT,
} from './braze-queue.constants';
import {
  BrazeJobData,
  BrazeJobLogEntry,
  BrazeJobLoggerOptions,
  BrazeQueueModuleOptions,
} from './braze-queue.interfaces';

const MASK = '[redacted]';
const MAX_DEPTH = 10;

/** `api_key`, `apiKey` and `API-KEY` all normalise to the same redaction key. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

/**
 * Request/response logging for queued Braze jobs.
 *
 * Lines are written with BullMQ's `job.log()`, so each job carries its own
 * request and response body and you can read them per job in Bull Board /
 * Bull Dashboard (the job's "Logs" tab) — including on failed jobs, which is
 * where you actually want them. Set `target` to also (or instead) mirror to
 * the Nest logger.
 *
 * Enabled once via the module's `logging` option and applied automatically to
 * every job the worker runs — you never wire logging into individual calls.
 *
 * Bodies are redacted (secret-ish keys masked) and truncated before they are
 * written, so turning this on in production stays safe and bounded. Writing to
 * the job log can never fail the job: Redis errors from the write are
 * swallowed.
 */
@Injectable()
export class BrazeJobLogger {
  private readonly logger = new Logger('BrazeJob');
  private readonly config: BrazeJobLoggerOptions;
  private readonly redactKeys: Set<string>;

  constructor(
    @Optional()
    @Inject(BRAZE_QUEUE_OPTIONS)
    options?: BrazeQueueModuleOptions,
  ) {
    this.config = BrazeJobLogger.resolve(options?.logging);
    this.redactKeys = new Set(
      (this.config.redact ?? DEFAULT_BRAZE_JOB_LOG_REDACT).map(normaliseKey),
    );
  }

  /**
   * Normalise the `logging` option into a config object.
   * `true` turns everything on with defaults; `undefined`/`false` keeps it off;
   * an object means "configured", so it is on unless `enabled: false`.
   */
  private static resolve(
    logging: BrazeQueueModuleOptions['logging'],
  ): BrazeJobLoggerOptions {
    if (logging === true) return { enabled: true };
    if (!logging) return { enabled: false };
    return { ...logging, enabled: logging.enabled !== false };
  }

  /** True when the worker should log jobs at all — checked before any work. */
  get enabled(): boolean {
    return this.config.enabled === true;
  }

  /** Written before the Braze call, so the payload is there even if it hangs. */
  async logRequest(job: Job<BrazeJobData>): Promise<void> {
    if (!this.enabled || this.config.request === false) return;
    const entry = this.entry('request', job);
    await this.emit(
      job,
      entry,
      `→ request ${this.body(entry.request)}`,
    );
  }

  /** Written after a successful call, with the body Braze sent back. */
  async logResponse(
    job: Job<BrazeJobData>,
    response: unknown,
    durationMs: number,
  ): Promise<void> {
    if (!this.enabled || this.config.response === false) return;
    const entry = this.entry('response', job);
    entry.response = this.sanitize(response);
    entry.durationMs = durationMs;
    await this.emit(
      job,
      entry,
      `← response (ok in ${durationMs}ms) ${this.body(entry.response)}`,
    );
  }

  /**
   * Written when the call rejects, before the error is rethrown for BullMQ to
   * retry. Includes the request body so a failed job is debuggable from its
   * own log alone.
   */
  async logError(
    job: Job<BrazeJobData>,
    error: unknown,
    durationMs: number,
  ): Promise<void> {
    if (!this.enabled || this.config.errors === false) return;
    const entry = this.entry('error', job);
    entry.durationMs = durationMs;

    const details = extractBrazeError(error);
    // Braze's `errors` array can echo payload fields, so redact it like a body.
    entry.error = {
      ...details,
      errors:
        details.errors === undefined
          ? undefined
          : this.sanitize(details.errors),
    };

    // status + errors are the part that names the rejected field; the generic
    // message alone ("Valid data must be provided in ...") is undebuggable.
    const status =
      entry.error.status === undefined ? '' : ` status=${entry.error.status}`;
    const brazeErrors =
      entry.error.errors === undefined
        ? ''
        : ` errors=${this.body(entry.error.errors)}`;

    await this.emit(
      job,
      entry,
      `✖ failed in ${durationMs}ms:${status} ${entry.error.message}${brazeErrors} — request ${this.body(
        entry.request,
      )}`,
      true,
    );
  }

  private entry(
    stage: BrazeJobLogEntry['stage'],
    job: Job<BrazeJobData>,
  ): BrazeJobLogEntry {
    const { method, args } = job.data;
    return {
      stage,
      method,
      jobId: job.id === undefined ? undefined : String(job.id),
      attempt: (job.attemptsMade ?? 0) + 1,
      maxAttempts: job.opts?.attempts,
      // Single-argument methods (the common case) read better unwrapped.
      request: this.sanitize(args?.length === 1 ? args[0] : args),
    };
  }

  /**
   * Fan one entry out to the configured destinations. A custom `sink` replaces
   * both built-in destinations.
   */
  private async emit(
    job: Job<BrazeJobData>,
    entry: BrazeJobLogEntry,
    detail: string,
    isError = false,
  ): Promise<void> {
    if (this.config.sink) {
      this.config.sink(entry);
      return;
    }

    const target = this.config.target ?? 'job';
    const attempts = entry.maxAttempts
      ? `${entry.attempt}/${entry.maxAttempts}`
      : `${entry.attempt}`;

    if (target === 'job' || target === 'both') {
      // Timestamped because Bull Board renders job log rows verbatim.
      await this.write(
        job,
        `[${new Date().toISOString()}] ${entry.method} attempt=${attempts} ${detail}`,
      );
    }

    if (target === 'logger' || target === 'both') {
      // Job id matters here — console lines aren't scoped to a job.
      const message = `${entry.method} job=${entry.jobId ?? '-'} attempt=${attempts} ${detail}`;
      if (isError) this.logger.error(message);
      else this.logger[this.config.level ?? 'log'](message);
    }
  }

  /** job.log() hits Redis; a failure there must never fail the delivery. */
  private async write(job: Job<BrazeJobData>, row: string): Promise<void> {
    try {
      await job.log(row);
    } catch (error) {
      this.logger.warn(
        `Could not write job log for ${job.id}: ${(error as Error)?.message}`,
      );
    }
  }

  /** Serialise an already-sanitized value for the log row, bounded in length. */
  private body(value: unknown): string {
    let text: string;
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }

    const max =
      this.config.maxBodyLength ?? DEFAULT_BRAZE_JOB_LOG_MAX_BODY_LENGTH;
    if (max > 0 && text.length > max) {
      return `${text.slice(0, max)}… (${text.length} chars, truncated)`;
    }
    return text;
  }

  /**
   * Deep-clone with secret-ish keys masked. Also guards against cycles and
   * runaway nesting so a bad payload can never wedge the worker.
   */
  private sanitize(value: unknown, seen = new WeakSet(), depth = 0): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '[depth limit]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitize(item, seen, depth + 1));
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = this.redactKeys.has(normaliseKey(key))
        ? MASK
        : this.sanitize(val, seen, depth + 1);
    }
    return out;
  }
}
