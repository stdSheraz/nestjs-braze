import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { JobsOptions, Queue } from 'bullmq';
import { BrazeService } from '../braze.service';
import {
  BrazeCampaignTrigger,
  BrazeCanvasTrigger,
  BrazeEvent,
  BrazePurchase,
  BrazeTrackPayload,
  BrazeUserAttributes,
} from '../braze.interfaces';
import {
  BRAZE_QUEUE,
  BRAZE_QUEUE_OPTIONS,
  DEFAULT_BRAZE_JOB_OPTIONS,
} from './braze-queue.constants';
import {
  BrazeJobData,
  BrazeQueueableMethod,
  BrazeQueueModuleOptions,
} from './braze-queue.interfaces';

type Alias = { alias_name: string; alias_label: string };
type SendMessagePayload = Parameters<BrazeService['sendMessage']>[0];
type SendTransactionalPayload = Parameters<BrazeService['sendTransactional']>[1];

/**
 * Durable, "fire-and-forget-but-guaranteed" counterpart of BrazeService.
 * Every method persists a job to Redis and returns immediately — the request
 * path never waits on Braze. A background worker (BrazeQueueProcessor) then
 * delivers the job with automatic retries, so nothing is lost across Braze
 * outages, deploys, or crashes (at-least-once delivery).
 *
 * The method surface mirrors BrazeService; each returns the enqueued BullMQ Job.
 */
@Injectable()
export class BrazeQueueService {
  private readonly defaultJobOptions: JobsOptions;

  constructor(
    @InjectQueue(BRAZE_QUEUE) private readonly queue: Queue<BrazeJobData>,
    @Inject(BRAZE_QUEUE_OPTIONS) options: BrazeQueueModuleOptions,
  ) {
    this.defaultJobOptions = {
      ...DEFAULT_BRAZE_JOB_OPTIONS,
      ...options.defaultJobOptions,
    };
  }

  /** Escape hatch: the raw BullMQ queue (add bulk jobs, inspect counts, etc.). */
  get queueRef(): Queue<BrazeJobData> {
    return this.queue;
  }

  private enqueue(
    method: BrazeQueueableMethod,
    args: unknown[],
    jobOpts?: JobsOptions,
  ) {
    return this.queue.add(
      method,
      { method, args },
      { ...this.defaultJobOptions, ...jobOpts },
    );
  }

  // ---- Users -----------------------------------------------------------

  trackUser(attributes: BrazeUserAttributes, jobOpts?: JobsOptions) {
    return this.enqueue('trackUser', [attributes], jobOpts);
  }

  logEvent(event: BrazeEvent, jobOpts?: JobsOptions) {
    return this.enqueue('logEvent', [event], jobOpts);
  }

  logPurchase(purchase: BrazePurchase, jobOpts?: JobsOptions) {
    return this.enqueue('logPurchase', [purchase], jobOpts);
  }

  track(payload: BrazeTrackPayload, jobOpts?: JobsOptions) {
    return this.enqueue('track', [payload], jobOpts);
  }

  identifyAlias(externalId: string, alias: Alias, jobOpts?: JobsOptions) {
    return this.enqueue('identifyAlias', [externalId, alias], jobOpts);
  }

  createAlias(externalId: string, alias: Alias, jobOpts?: JobsOptions) {
    return this.enqueue('createAlias', [externalId, alias], jobOpts);
  }

  deleteUsers(externalIds: string[], jobOpts?: JobsOptions) {
    return this.enqueue('deleteUsers', [externalIds], jobOpts);
  }

  exportUsers(externalIds: string[], jobOpts?: JobsOptions) {
    return this.enqueue('exportUsers', [externalIds], jobOpts);
  }

  // ---- Messaging -------------------------------------------------------

  triggerCampaign(payload: BrazeCampaignTrigger, jobOpts?: JobsOptions) {
    return this.enqueue('triggerCampaign', [payload], jobOpts);
  }

  triggerCanvas(payload: BrazeCanvasTrigger, jobOpts?: JobsOptions) {
    return this.enqueue('triggerCanvas', [payload], jobOpts);
  }

  sendMessage(payload: SendMessagePayload, jobOpts?: JobsOptions) {
    return this.enqueue('sendMessage', [payload], jobOpts);
  }

  sendTransactional(
    campaignId: string,
    payload: SendTransactionalPayload,
    jobOpts?: JobsOptions,
  ) {
    return this.enqueue('sendTransactional', [campaignId, payload], jobOpts);
  }

  // ---- Subscriptions / compliance -------------------------------------

  setEmailSubscription(
    externalId: string,
    state: 'opted_in' | 'subscribed' | 'unsubscribed',
    jobOpts?: JobsOptions,
  ) {
    return this.enqueue('setEmailSubscription', [externalId, state], jobOpts);
  }

  setSubscriptionGroup(
    groupId: string,
    state: 'subscribed' | 'unsubscribed',
    externalIds: string[],
    jobOpts?: JobsOptions,
  ) {
    return this.enqueue(
      'setSubscriptionGroup',
      [groupId, state, externalIds],
      jobOpts,
    );
  }
}
