# nestjs-braze

NestJS module for the [Braze](https://www.braze.com) REST API. Register once, inject a typed `BrazeService` anywhere to track users, log events and purchases, trigger campaigns/Canvases, and manage subscription states.

Built on top of [`braze-api`](https://www.npmjs.com/package/braze-api).

## Features

- 🔌 **Dynamic module** — `forRoot` / `forRootAsync` with `ConfigService` support
- 🌍 **Global** — register once in `AppModule`, inject everywhere
- 🛡️ **Never breaks your flow** — errors are logged and swallowed by default; opt into throwing with `{ throwOnError: true }`
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
