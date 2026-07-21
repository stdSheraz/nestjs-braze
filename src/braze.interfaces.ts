import { ModuleMetadata } from '@nestjs/common';

export interface BrazeModuleOptions {
  /** REST endpoint, e.g. https://rest.iad-07.braze.com */
  endpoint: string;
  /** REST API key with the permissions you need (users.track, etc.) */
  apiKey: string;
  /**
   * When false, every service method becomes a silent no-op.
   * Useful for local/dev environments so you don't pollute the workspace.
   * Defaults to true.
   */
  enabled?: boolean;
}

export interface BrazeModuleAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (
    ...args: any[]
  ) => Promise<BrazeModuleOptions> | BrazeModuleOptions;
  inject?: any[];
}

export interface BrazeServerResponse {
  message: string;
  errors?: unknown[];
}

/** Options accepted by every BrazeService method. */
export interface BrazeCallOptions {
  /**
   * By default Braze errors are logged and swallowed so they never crash a
   * business flow. Set true to rethrow the error to the caller instead.
   * Ignored when `fireAndForget` is true — there is no caller awaiting it.
   */
  throwOnError?: boolean;
  /**
   * Fire-and-forget: kick the request off in the background and return
   * immediately (resolving to null) without awaiting the HTTP round-trip.
   * Errors are still logged but never thrown. Use for non-critical side
   * effects (analytics events, attribute syncs) on a hot request path where
   * you don't want to pay Braze's latency.
   */
  fireAndForget?: boolean;
}

/** Standard + custom attributes for a user profile. */
export interface BrazeUserAttributes {
  external_id?: string;
  user_alias?: { alias_name: string; alias_label: string };
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  language?: string;
  country?: string;
  home_city?: string;
  gender?: string;
  dob?: string; // YYYY-MM-DD
  email_subscribe?: 'opted_in' | 'subscribed' | 'unsubscribed';
  push_subscribe?: 'opted_in' | 'subscribed' | 'unsubscribed';
  _update_existing_only?: boolean;
  /** Any custom attribute: string | number | boolean | null | array | { add, remove } | { inc } | nested object */
  [custom: string]: unknown;
}

export interface BrazeEvent {
  external_id?: string;
  user_alias?: { alias_name: string; alias_label: string };
  name: string;
  time?: string; // ISO 8601 — defaults to now
  properties?: Record<string, unknown>;
}

export interface BrazePurchase {
  external_id?: string;
  user_alias?: { alias_name: string; alias_label: string };
  product_id: string;
  currency: string; // ISO 4217, e.g. 'SAR'
  price: number;
  quantity?: number;
  time?: string; // ISO 8601 — defaults to now
  properties?: Record<string, unknown>;
}

export interface BrazeTrackPayload {
  attributes?: BrazeUserAttributes[];
  events?: BrazeEvent[];
  purchases?: BrazePurchase[];
}

export interface BrazeCampaignTrigger {
  campaign_id: string;
  /** Per-user or broadcast recipients */
  recipients?: Array<{
    external_user_id?: string;
    user_alias?: { alias_name: string; alias_label: string };
    trigger_properties?: Record<string, unknown>;
    send_to_existing_only?: boolean;
    attributes?: Record<string, unknown>;
  }>;
  trigger_properties?: Record<string, unknown>;
  broadcast?: boolean;
  send_id?: string;
}

export interface BrazeCanvasTrigger {
  canvas_id: string;
  recipients?: Array<{
    external_user_id?: string;
    user_alias?: { alias_name: string; alias_label: string };
    canvas_entry_properties?: Record<string, unknown>;
  }>;
  canvas_entry_properties?: Record<string, unknown>;
  broadcast?: boolean;
}
