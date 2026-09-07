import { Inject, Injectable, Logger } from '@nestjs/common';
import { Braze } from 'braze-api';
import { BRAZE_CLIENT, BRAZE_OPTIONS } from './braze.constants';
import {
  extractBrazeError,
  formatBrazeErrorDetails,
} from './braze.errors';
import {
  BrazeCallOptions,
  BrazeCampaignTrigger,
  BrazeCanvasTrigger,
  BrazeEvent,
  BrazeModuleOptions,
  BrazePurchase,
  BrazeServerResponse,
  BrazeTrackPayload,
  BrazeUserAttributes,
} from './braze.interfaces';

/**
 * Backend counterpart of the mobile BrazeService: one injectable class that
 * owns the braze-api client. Mirrors the mobile philosophy — Braze must never
 * crash a business flow, so errors are logged and swallowed by default.
 * Methods that you *need* to know succeeded accept { throwOnError: true }.
 */
@Injectable()
export class BrazeService {
  private readonly logger = new Logger(BrazeService.name);

  constructor(
    @Inject(BRAZE_OPTIONS) private readonly options: BrazeModuleOptions,
    @Inject(BRAZE_CLIENT) private readonly braze: Braze,
  ) {}

  /** Escape hatch for endpoints this wrapper doesn't cover. */
  get client(): Braze {
    return this.braze;
  }

  get isEnabled(): boolean {
    return this.options.enabled !== false;
  }

  // ---------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------

  /**
   * Create or update a user profile. Equivalent of the mobile
   * identifyUser + set*Attribute methods. Creates the user if the
   * external_id does not exist yet.
   */
  async trackUser(
    attributes: BrazeUserAttributes,
    opts?: BrazeCallOptions,
  ) {
    return this.track({ attributes: [attributes] }, opts);
  }

  /** Log a custom event. Equivalent of logCustomEvent on mobile. */
  async logEvent(event: BrazeEvent, opts?: BrazeCallOptions) {
    return this.track(
      { events: [{ time: new Date().toISOString(), ...event }] },
      opts,
    );
  }

  /** Log a purchase. Equivalent of logPurchase on mobile. */
  async logPurchase(
    purchase: BrazePurchase,
    opts?: BrazeCallOptions,
  ) {
    return this.track(
      {
        purchases: [
          { quantity: 1, time: new Date().toISOString(), ...purchase },
        ],
      },
      opts,
    );
  }

  /**
   * Raw /users/track — batch attributes, events and purchases in one call.
   * Braze accepts up to 75 objects per request; this method chunks
   * automatically so callers never have to think about the limit.
   */
  async track(payload: BrazeTrackPayload, opts?: BrazeCallOptions) {
    return this.execute(
      'users.track',
      async () => {
        const chunks = this.chunkTrackPayload(payload, 75);
        const results = [];
        for (const chunk of chunks) {
          results.push(await this.braze.users.track(chunk as any));
        }
        return results;
      },
      opts,
    );
  }

  /** Merge an alias-only user into an identified (external_id) profile. */
  async identifyAlias(
    externalId: string,
    alias: { alias_name: string; alias_label: string },
    opts?: BrazeCallOptions,
  ): Promise<BrazeServerResponse | null> {
    return this.execute(
      'users.identify',
      () =>
        this.braze.users.identify({
          aliases_to_identify: [
            { external_id: externalId, user_alias: alias },
          ],
        } as any),
      opts,
    );
  }

  /** Attach a new alias to an existing user. */
  async createAlias(
    externalId: string,
    alias: { alias_name: string; alias_label: string },
    opts?: BrazeCallOptions,
  ): Promise<BrazeServerResponse | null> {
    return this.execute(
      'users.alias.new',
      () =>
        this.braze.users.alias.new({
          user_aliases: [{ external_id: externalId, ...alias }],
        } as any),
      opts,
    );
  }

  /** GDPR-style delete of user profiles. */
  async deleteUsers(externalIds: string[], opts?: BrazeCallOptions) {
    return this.execute(
      'users.delete',
      () => this.braze.users.delete({ external_ids: externalIds } as any),
      opts,
    );
  }

  /** Export full profile data for given users. */
  async exportUsers(externalIds: string[], opts?: BrazeCallOptions) {
    return this.execute(
      'users.export.ids',
      () => this.braze.users.export.ids({ external_ids: externalIds } as any),
      opts,
    );
  }

  // ---------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------

  /** Fire an API-triggered campaign (transactional push/email/SMS). */
  async triggerCampaign(
    payload: BrazeCampaignTrigger,
    opts?: BrazeCallOptions,
  ) {
    return this.execute(
      'campaigns.trigger.send',
      () => this.braze.campaigns.trigger.send(payload as any),
      opts,
    );
  }

  /** Fire an API-triggered Canvas. */
  async triggerCanvas(
    payload: BrazeCanvasTrigger,
    opts?: BrazeCallOptions,
  ) {
    return this.execute(
      'canvas.trigger.send',
      () => this.braze.canvas.trigger.send(payload as any),
      opts,
    );
  }

  // ---------------------------------------------------------------------
  // Subscriptions / compliance
  // ---------------------------------------------------------------------

  /**
   * Set a user's global email subscription state.
   * (braze-api has no /email/status wrapper; Braze also accepts this via
   * users.track, which is what we use here.)
   */
  async setEmailSubscription(
    externalId: string,
    state: 'opted_in' | 'subscribed' | 'unsubscribed',
    opts?: BrazeCallOptions,
  ) {
    return this.trackUser(
      { external_id: externalId, email_subscribe: state },
      opts,
    );
  }

  /** Send an immediate ad-hoc message (push/email/SMS) without a campaign. */
  async sendMessage(
    payload: Parameters<Braze['messages']['send']>[0],
    opts?: BrazeCallOptions,
  ) {
    return this.execute(
      'messages.send',
      () => this.braze.messages.send(payload),
      opts,
    );
  }

  /** Send a transactional email campaign (dedicated low-latency endpoint). */
  async sendTransactional(
    campaignId: string,
    payload: Omit<
      Parameters<Braze['transactional']['v1']['campaigns']['send']>[1],
      never
    >,
    opts?: BrazeCallOptions,
  ) {
    return this.execute(
      'transactional.send',
      () => this.braze.transactional.v1.campaigns.send(campaignId, payload),
      opts,
    );
  }

  /** Opt users in/out of a subscription group (SMS/email/WhatsApp). */
  async setSubscriptionGroup(
    groupId: string,
    state: 'subscribed' | 'unsubscribed',
    externalIds: string[],
    opts?: BrazeCallOptions,
  ) {
    return this.execute(
      'subscription.status.set',
      () =>
        this.braze.subscription.status.set({
          subscription_group_id: groupId,
          subscription_state: state,
          external_id: externalIds,
        } as any),
      opts,
    );
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async execute<T>(
    op: string,
    fn: () => Promise<T>,
    opts?: BrazeCallOptions,
  ): Promise<T | null> {
    if (!this.isEnabled) {
      this.logger.debug(`Braze disabled — skipping ${op}`);
      return null;
    }

    if (opts?.fireAndForget) {
      // Best-effort background send: kick it off and resolve immediately.
      // run() logs-and-swallows (throwOnError is forced off), so the floating
      // promise can never surface as an unhandledRejection. NOTE: in-memory
      // only — a process crash/restart mid-flight drops the event. For
      // guaranteed at-least-once delivery use BrazeQueueModule (nestjs-braze/queue).
      void this.run(op, fn);
      return null;
    }

    return this.run(op, fn, opts);
  }

  private async run<T>(
    op: string,
    fn: () => Promise<T>,
    opts?: BrazeCallOptions,
  ): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      // Include Braze's status + per-field errors: its message for a rejected
      // payload is generic, and the `errors` array is what names the bad field.
      const details = extractBrazeError(error);
      this.logger.error(
        `Braze ${op} failed${formatBrazeErrorDetails(details)}`,
        error as Error,
      );
      if (opts?.throwOnError) throw error;
      return null;
    }
  }

  /** Split a track payload into chunks of at most `size` total objects. */
  private chunkTrackPayload(
    payload: BrazeTrackPayload,
    size: number,
  ): BrazeTrackPayload[] {
    const items: Array<
      | { kind: 'attributes'; value: BrazeUserAttributes }
      | { kind: 'events'; value: BrazeEvent }
      | { kind: 'purchases'; value: BrazePurchase }
    > = [
      ...(payload.attributes ?? []).map((value) => ({
        kind: 'attributes' as const,
        value,
      })),
      ...(payload.events ?? []).map((value) => ({
        kind: 'events' as const,
        value,
      })),
      ...(payload.purchases ?? []).map((value) => ({
        kind: 'purchases' as const,
        value,
      })),
    ];

    if (items.length === 0) return [];

    const chunks: BrazeTrackPayload[] = [];
    for (let i = 0; i < items.length; i += size) {
      const slice = items.slice(i, i + size);
      const chunk: BrazeTrackPayload = {};
      for (const item of slice) {
        ((chunk[item.kind] ??= []) as unknown[]).push(item.value);
      }
      chunks.push(chunk);
    }
    return chunks;
  }
}
