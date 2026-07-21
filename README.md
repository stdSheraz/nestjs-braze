# nestjs-braze

NestJS module for the [Braze](https://www.braze.com) REST API. Register once, inject a typed `BrazeService` anywhere to track users, log events and purchases, trigger campaigns/Canvases, and manage subscription states.

Built on top of [`braze-api`](https://www.npmjs.com/package/braze-api).

## Features

- 🔌 **Dynamic module** — `forRoot` / `forRootAsync` with `ConfigService` support
- 🌍 **Global** — register once in `AppModule`, inject everywhere
- 🛡️ **Never breaks your flow** — errors are logged and swallowed by default; opt into throwing with `{ throwOnError: true }`
- ⏱️ **Three delivery modes** — `await` (wait for it), `{ fireAndForget: true }` (best-effort background), or a durable **BullMQ + Redis queue** for guaranteed at-least-once delivery
- 🔇 **Disable switch** — `enabled: false` turns every call into a silent no-op (great for local dev)
- 📦 **Auto-batching** — `track()` chunks payloads to Braze's 75-objects-per-request limit
- 🧰 **Escape hatch** — `service.client` exposes the raw `braze-api` instance for anything not wrapped

## Install

```bash
npm install nestjs-braze braze-api
```

## Setup

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BrazeModule } from 'nestjs-braze';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BrazeModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const enabled = config.get('BRAZE_ENABLED') === 'true';
        return {
          enabled,
          endpoint: enabled
            ? config.getOrThrow('BRAZE_REST_ENDPOINT')
            : 'https://rest.iad-01.braze.com',
          apiKey: enabled ? config.getOrThrow('BRAZE_REST_API_KEY') : 'disabled',
        };
      },
    }),
  ],
})
export class AppModule {}
```

```env
BRAZE_ENABLED=true
BRAZE_REST_ENDPOINT=https://rest.iad-07.braze.com
BRAZE_REST_API_KEY=your-rest-api-key
```

Or statically: `BrazeModule.forRoot({ endpoint, apiKey, enabled: true })`.

## Usage

```typescript
import { Injectable } from '@nestjs/common';
import { BrazeService } from 'nestjs-braze';

@Injectable()
export class UsersService {
  constructor(private readonly braze: BrazeService) {}

  async register(user: User) {
    // Create/update a profile (creates the user if external_id is new)
    await this.braze.trackUser({
      external_id: user.id,
      first_name: user.firstName,
      email: user.email,
      plan: 'free', // custom attributes go right alongside
    });

    // Log an event
    await this.braze.logEvent({
      external_id: user.id,
      name: 'user_registered',
      properties: { method: 'email' },
    });
  }
}
```

### Purchases

```typescript
await braze.logPurchase({
  external_id: userId,
  product_id: 'sku_123',
  currency: 'USD',
  price: 99.0,
  properties: { category: 'shoes' },
});
```

### Custom attribute operations

```typescript
await braze.trackUser({
  external_id: userId,
  orders_count: { inc: 1 },                                  // increment
  favorite_tags: { add: ['sale'], remove: ['expired'] },     // array ops
  temp_flag: null,                                           // unset
  address: { city: 'Riyadh', zip: '12345' },                 // nested object
});
```

### Batch (auto-chunked to 75/request)

```typescript
await braze.track({
  attributes: users.map((u) => ({ external_id: u.id, plan: u.plan })),
});
```

### Trigger campaigns / Canvases

```typescript
await braze.triggerCampaign(
  {
    campaign_id: 'your-campaign-id',
    recipients: [
      { external_user_id: userId, trigger_properties: { otp: '482913' } },
    ],
  },
  { throwOnError: true }, // OTP must not fail silently
);

await braze.triggerCanvas({ canvas_id: '...', recipients: [...] });
```

### Aliases (pre-signup leads)

```typescript
// Create an alias-only user (no external_id yet)
await braze.trackUser({
  user_alias: { alias_name: email, alias_label: 'email' },
  email,
  _update_existing_only: false,
});

// After signup, merge into the identified profile
await braze.identifyAlias(userId, { alias_name: email, alias_label: 'email' });
```

### Subscriptions & compliance

```typescript
await braze.setEmailSubscription(userId, 'unsubscribed');
await braze.setSubscriptionGroup('group-id', 'subscribed', [userId]);
await braze.deleteUsers([userId]); // GDPR delete
```

### Raw client escape hatch

```typescript
const segments = await braze.client.segments.list({ page: 0 });
const tpl = await braze.client.templates.email_templates.list({});
```

## Error handling

Every wrapped method catches errors, logs them through Nest's `Logger`, and resolves to `null` — analytics must never crash a business flow. When a call must succeed, pass `{ throwOnError: true }` as the last argument.

## Delivery modes

Every `BrazeService` method supports three ways to deliver a call. Pick per call.

| Mode | How | Latency on your request | Guarantee | Needs |
|---|---|---|---|---|
| **Await** (default) | `await braze.trackUser(...)` | Waits for the Braze round-trip | You see the result / error | — |
| **Fire-and-forget** | `braze.trackUser(..., { fireAndForget: true })` | Returns instantly (`null`) | **Best-effort** — lost on crash/restart mid-flight; no retry | — |
| **Durable queue** | `brazeQueue.trackUser(...)` | Returns once persisted to Redis | **At-least-once** — survives crashes, deploys, Braze outages; auto-retry | Redis + BullMQ |

### 1. Await (default)

```typescript
const res = await braze.trackUser({ external_id: userId, plan: 'premium' });
// res is the Braze response, or null if it failed (logged) / Braze is disabled
```

### 2. Fire-and-forget (best-effort)

Kick the request off in the background and return immediately. Good for non-critical
side effects on a hot path where you don't want to pay Braze's latency. The error is
still logged, never thrown — and it can never crash your process with an unhandled
rejection. **It is not durable:** if the process restarts before the in-flight request
finishes, that event is lost.

```typescript
braze.logEvent({ external_id: userId, name: 'page_view' }, { fireAndForget: true });
// no await — your handler returns without waiting for Braze
```

### 3. Durable queue — guaranteed at-least-once (BullMQ + Redis)

When you cannot afford to lose events, enqueue them instead. Each call is persisted to
Redis (so it returns almost instantly, like fire-and-forget) and a background worker
delivers it to Braze with automatic exponential-backoff retries. Nothing is lost across
crashes, deploys, or Braze downtime.

This is **opt-in** and imported from the `nestjs-braze/queue` subpath, so apps that
don't need it never pull in BullMQ.

```bash
npm install @nestjs/bullmq bullmq
```

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BrazeModule } from 'nestjs-braze';
import { BrazeQueueModule } from 'nestjs-braze/queue';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // 1. the base client (the worker calls this under the hood)
    BrazeModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        endpoint: config.getOrThrow('BRAZE_REST_ENDPOINT'),
        apiKey: config.getOrThrow('BRAZE_REST_API_KEY'),
      }),
    }),
    // 2. the durable queue (Redis-backed)
    BrazeQueueModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow('REDIS_HOST'),
          port: Number(config.get('REDIS_PORT') ?? 6379),
          password: config.get('REDIS_PASSWORD'),
        },
      }),
    }),
  ],
})
export class AppModule {}
```

Inject `BrazeQueueService` and call it exactly like `BrazeService` — same methods, minus
the options bag; the last argument is optional [BullMQ job options](https://docs.bullmq.io/guide/jobs) instead:

```typescript
import { Injectable } from '@nestjs/common';
import { BrazeQueueService } from 'nestjs-braze/queue';

@Injectable()
export class OrdersService {
  constructor(private readonly brazeQueue: BrazeQueueService) {}

  async checkout(userId: string) {
    // returns as soon as the job is safely in Redis; delivered + retried in the background
    await this.brazeQueue.logPurchase({
      external_id: userId,
      product_id: 'sku_123',
      currency: 'USD',
      price: 99.0,
    });

    // override retry/scheduling per call with BullMQ job options
    await this.brazeQueue.logEvent(
      { external_id: userId, name: 'order_placed' },
      { attempts: 10, backoff: { type: 'exponential', delay: 5000 } },
    );
  }
}
```

**Defaults:** jobs retry 5× with exponential backoff; completed jobs are trimmed to the
last 1000; failed jobs are kept in Redis for inspection / manual retry. Override globally
via `defaultJobOptions`, or per call via the last argument.

**Separate web / worker processes:** set `runWorker: false` on API nodes that should only
enqueue, and run a dedicated worker process that imports `BrazeQueueModule` with the
default (`runWorker: true`) to drain the queue.

> Static config works too: `BrazeQueueModule.forRoot({ connection: { host, port } })`.

## API

| Method | Braze endpoint |
|---|---|
| `trackUser(attrs)` | `POST /users/track` |
| `logEvent(event)` | `POST /users/track` |
| `logPurchase(purchase)` | `POST /users/track` |
| `track(payload)` | `POST /users/track` (batched) |
| `identifyAlias(id, alias)` | `POST /users/identify` |
| `createAlias(id, alias)` | `POST /users/alias/new` |
| `deleteUsers(ids)` | `POST /users/delete` |
| `exportUsers(ids)` | `POST /users/export/ids` |
| `triggerCampaign(payload)` | `POST /campaigns/trigger/send` |
| `triggerCanvas(payload)` | `POST /canvas/trigger/send` |
| `sendMessage(payload)` | `POST /messages/send` |
| `sendTransactional(id, payload)` | `POST /transactional/v1/campaigns/:id/send` |
| `setEmailSubscription(id, state)` | via `POST /users/track` |
| `setSubscriptionGroup(...)` | `POST /subscription/status/set` |
| `client` | raw `braze-api` instance |

## License

MIT
