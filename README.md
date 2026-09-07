# nestjs-braze

NestJS module for the [Braze](https://www.braze.com) REST API. Register once, inject a typed `BrazeService` anywhere to track users, log events and purchases, trigger campaigns/Canvases, and manage subscription states.

Built on top of [`braze-api`](https://www.npmjs.com/package/braze-api).

## Features

- 🔌 **Dynamic module** — `forRoot` / `forRootAsync` with `ConfigService` support
- 🌍 **Global** — register once in `AppModule`, inject everywhere
- 🛡️ **Never breaks your flow** — errors are logged and swallowed by default; opt into throwing with `{ throwOnError: true }`
- ⏱️ **Three delivery modes** — `await` (wait for it), `{ fireAndForget: true }` (best-effort background), or a durable **BullMQ + Redis queue** for guaranteed at-least-once delivery
- 🔇 **Disable switch** — `enabled: false` turns every call into a silent no-op (great for local dev)
- 🔍 **Job request/response logging** — one `logging: true` and every queued job records what was sent to Braze and what came back, readable per job in Bull Board
- 📦 **Auto-batching** — `track()` chunks payloads to Braze's 75-objects-per-request limit
- 🧰 **Escape hatch** — `service.client` exposes the raw `braze-api` instance for anything not wrapped

## Install

```bash
npm install nestjs-braze braze-api
```

## Setup

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BrazeModule } from "nestjs-braze";

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		BrazeModule.forRootAsync({
			inject: [ConfigService],
			useFactory: (config: ConfigService) => {
				const enabled = config.get("BRAZE_ENABLED") === "true";
				return {
					enabled,
					endpoint: enabled
						? config.getOrThrow("BRAZE_REST_ENDPOINT")
						: "https://rest.iad-01.braze.com",
					apiKey: enabled
						? config.getOrThrow("BRAZE_REST_API_KEY")
						: "disabled",
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
import { Injectable } from "@nestjs/common";
import { BrazeService } from "nestjs-braze";

@Injectable()
export class UsersService {
	constructor(private readonly braze: BrazeService) {}

	async register(user: User) {
		// Create/update a profile (creates the user if external_id is new)
		await this.braze.trackUser({
			external_id: user.id,
			first_name: user.firstName,
			email: user.email,
			plan: "free", // custom attributes go right alongside
		});

		// Log an event
		await this.braze.logEvent({
			external_id: user.id,
			name: "user_registered",
			properties: { method: "email" },
		});
	}
}
```

### Purchases

```typescript
await braze.logPurchase({
	external_id: userId,
	product_id: "sku_123",
	currency: "USD",
	price: 99.0,
	properties: { category: "shoes" },
});
```

### Custom attribute operations

```typescript
await braze.trackUser({
	external_id: userId,
	orders_count: { inc: 1 }, // increment
	favorite_tags: { add: ["sale"], remove: ["expired"] }, // array ops
	temp_flag: null, // unset
	address: { city: "Riyadh", zip: "12345" }, // nested object
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
	user_alias: { alias_name: email, alias_label: "email" },
	email,
	_update_existing_only: false,
});

// After signup, merge into the identified profile
await braze.identifyAlias(userId, { alias_name: email, alias_label: "email" });
```

### Subscriptions & compliance

```typescript
await braze.setEmailSubscription(userId, "unsubscribed");
await braze.setSubscriptionGroup("group-id", "subscribed", [userId]);
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

| Mode                | How                                             | Latency on your request         | Guarantee                                                                | Needs          |
| ------------------- | ----------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ | -------------- |
| **Await** (default) | `await braze.trackUser(...)`                    | Waits for the Braze round-trip  | You see the result / error                                               | —              |
| **Fire-and-forget** | `braze.trackUser(..., { fireAndForget: true })` | Returns instantly (`null`)      | **Best-effort** — lost on crash/restart mid-flight; no retry             | —              |
| **Durable queue**   | `brazeQueue.trackUser(...)`                     | Returns once persisted to Redis | **At-least-once** — survives crashes, deploys, Braze outages; auto-retry | Redis + BullMQ |

### 1. Await (default)

```typescript
const res = await braze.trackUser({ external_id: userId, plan: "premium" });
// res is the Braze response, or null if it failed (logged) / Braze is disabled
```

### 2. Fire-and-forget (best-effort)

Kick the request off in the background and return immediately. Good for non-critical
side effects on a hot path where you don't want to pay Braze's latency. The error is
still logged, never thrown — and it can never crash your process with an unhandled
rejection. **It is not durable:** if the process restarts before the in-flight request
finishes, that event is lost.

```typescript
braze.logEvent(
	{ external_id: userId, name: "page_view" },
	{ fireAndForget: true },
);
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
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BrazeModule } from "nestjs-braze";
import { BrazeQueueModule } from "nestjs-braze/queue";

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		// 1. the base client (the worker calls this under the hood)
		BrazeModule.forRootAsync({
			inject: [ConfigService],
			useFactory: (config: ConfigService) => ({
				endpoint: config.getOrThrow("BRAZE_REST_ENDPOINT"),
				apiKey: config.getOrThrow("BRAZE_REST_API_KEY"),
			}),
		}),
		// 2. the durable queue (Redis-backed)
		BrazeQueueModule.forRootAsync({
			inject: [ConfigService],
			useFactory: (config: ConfigService) => ({
				connection: {
					host: config.getOrThrow("REDIS_HOST"),
					port: Number(config.get("REDIS_PORT") ?? 6379),
					password: config.get("REDIS_PASSWORD"),
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
import { Injectable } from "@nestjs/common";
import { BrazeQueueService } from "nestjs-braze/queue";

@Injectable()
export class OrdersService {
	constructor(private readonly brazeQueue: BrazeQueueService) {}

	async checkout(userId: string) {
		// returns as soon as the job is safely in Redis; delivered + retried in the background
		await this.brazeQueue.logPurchase({
			external_id: userId,
			product_id: "sku_123",
			currency: "USD",
			price: 99.0,
		});

		// override retry/scheduling per call with BullMQ job options
		await this.brazeQueue.logEvent(
			{ external_id: userId, name: "order_placed" },
			{ attempts: 10, backoff: { type: "exponential", delay: 5000 } },
		);
	}
}
```

**Queue name:** jobs are enqueued on a BullMQ queue named **`braze`** — that's the name
you'll see in Redis and in dashboards like Bull Board. It's fixed (not configurable), so
producer and worker always agree on it.

**Defaults:** jobs retry 5× with exponential backoff; completed jobs are trimmed to the
last 1000; failed jobs are kept in Redis for inspection / manual retry. Override globally
via `defaultJobOptions`, or per call via the last argument.

**Separate web / worker processes:** set `runWorker: false` on API nodes that should only
enqueue, and run a dedicated worker process that imports `BrazeQueueModule` with the
default (`runWorker: true`) to drain the queue.

> Static config works too: `BrazeQueueModule.forRoot({ connection: { host, port } })`.

### Job logging — see the request & response in Bull Board

Turn on `logging` once and every job the worker runs records the payload sent to Braze
and the body Braze returned, written with BullMQ's `job.log()`. That means you read them
**per job** in Bull Board / Bull Dashboard (the job's **Logs** tab) — including on failed
jobs, which is where you actually want them. There's nothing to wire per call: enable it
in the module config and it applies to every job automatically.

```typescript
BrazeQueueModule.forRootAsync({
	inject: [ConfigService],
	useFactory: (config: ConfigService) => ({
		connection: { host: config.getOrThrow("REDIS_HOST"), port: 6379 },
		logging: true, // ← that's it: all jobs now log request + response
	}),
});
```

A job's log then reads:

```
[2026-01-14T09:12:04.061Z] logPurchase attempt=1/5 → request {"external_id":"u_1","product_id":"sku_123","currency":"USD","price":99}
[2026-01-14T09:12:04.198Z] logPurchase attempt=1/5 ← response (ok in 137ms) [{"message":"success"}]
```

...and a failing job keeps Braze's HTTP status, its **per-field error codes**, and the
request body all on one line, so a retry is debuggable on its own:

```
[2026-01-14T09:12:04.061Z] trackUser attempt=5/5 ✖ failed in 198ms: status=400 Valid data must be provided in the 'attributes', 'events', or 'purchases' fields. errors=[{"type":"EMAIL_BAD_FORMAT","input_array":"attributes","index":0}] — request {"external_id":"u_1","email":"","plan":"premium"}
```

That `errors` array is the part worth having: Braze's *message* for a rejected payload is
the generic "Valid data must be provided in ..." regardless of what it disliked, while
`errors` names the actual field — here `EMAIL_BAD_FORMAT`, sitting right next to the
`"email": ""` that caused it. Retrying can't fix a payload Braze considers invalid, so
seeing the field immediately is the difference between a one-minute fix and a long guess.

Pass an object instead of `true` to tune it:

```typescript
logging: {
	// flip it from an env var without removing the config
	enabled: config.get("BRAZE_JOB_LOGGING") === "true",
	// 'job' (default) = job.log(), for Bull Board | 'logger' = Nest stdout logger | 'both'
	target: "both",
	request: true,          // log the outgoing payload (default true)
	response: true,         // log Braze's response body (default true)
	errors: true,           // log failures (default true)
	level: "debug",         // Nest logger level for the 'logger'/'both' targets
	maxBodyLength: 4000,    // truncate long bodies (default 10000; 0 = no limit)
	redact: ["api_key", "email", "phone"], // keys to mask in logged bodies
}
```

**Redaction:** secret-ish keys (`api_key`, `authorization`, `password`, `token`, ...) are
masked as `[redacted]` by default — see `DEFAULT_BRAZE_JOB_LOG_REDACT`. Braze payloads are
mostly PII by nature, so if your dashboard or log sink shouldn't see it, add `email`,
`phone` etc. to `redact` (it *replaces* the default list rather than extending it).
Bodies are also truncated, and cycles/deep nesting are handled, so a bad payload can never
wedge the worker. A `job.log()` write that fails (Redis blip) is swallowed — logging never
fails a delivery.

**Custom sink:** send structured entries to Datadog, Sentry, or your own table instead:

```typescript
logging: {
	sink: (entry) => {
		// entry: { stage: 'request' | 'response' | 'error', method, jobId, attempt,
		//          maxAttempts, request, response?, error?, durationMs? }
		datadog.log("braze.job", entry);
	},
}
```

> A `sink` replaces both built-in destinations — nothing goes to the job log or the Nest logger.
> Logging is **off by default**, and only ever runs in processes that run the worker
> (`runWorker !== false`).

### One module for both (client + queue)

The setup above uses two modules — `BrazeModule` for the client and `BrazeQueueModule`
for the queue — which is the right choice when only some nodes need the worker, or when
you want the client without Redis. If you'd rather configure everything in a single call,
use `forRootWithClient` / `forRootWithClientAsync`. It registers the base client **and**
the queue, so both `BrazeService` and `BrazeQueueService` become injectable — pick per
call which delivery guarantee you want. **Don't also register `BrazeModule` separately.**

```typescript
// app.module.ts
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BrazeQueueModule } from "nestjs-braze/queue";

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		BrazeQueueModule.forRootWithClientAsync({
			inject: [ConfigService],
			useFactory: (config: ConfigService) => ({
				endpoint: config.getOrThrow("BRAZE_REST_ENDPOINT"),
				apiKey: config.getOrThrow("BRAZE_REST_API_KEY"),
				connection: {
					host: config.getOrThrow("REDIS_HOST"),
					port: Number(config.get("REDIS_PORT") ?? 6379),
					password: config.get("REDIS_PASSWORD"),
				},
			}),
		}),
	],
})
export class AppModule {}
```

```typescript
@Injectable()
export class UsersService {
	constructor(
		private readonly braze: BrazeService, // direct: await / fireAndForget
		private readonly brazeQueue: BrazeQueueService, // durable: at-least-once
	) {}
}
```

> Static equivalent: `BrazeQueueModule.forRootWithClient({ endpoint, apiKey, connection })`.

## API

| Method                            | Braze endpoint                              |
| --------------------------------- | ------------------------------------------- |
| `trackUser(attrs)`                | `POST /users/track`                         |
| `logEvent(event)`                 | `POST /users/track`                         |
| `logPurchase(purchase)`           | `POST /users/track`                         |
| `track(payload)`                  | `POST /users/track` (batched)               |
| `identifyAlias(id, alias)`        | `POST /users/identify`                      |
| `createAlias(id, alias)`          | `POST /users/alias/new`                     |
| `deleteUsers(ids)`                | `POST /users/delete`                        |
| `exportUsers(ids)`                | `POST /users/export/ids`                    |
| `triggerCampaign(payload)`        | `POST /campaigns/trigger/send`              |
| `triggerCanvas(payload)`          | `POST /canvas/trigger/send`                 |
| `sendMessage(payload)`            | `POST /messages/send`                       |
| `sendTransactional(id, payload)`  | `POST /transactional/v1/campaigns/:id/send` |
| `setEmailSubscription(id, state)` | via `POST /users/track`                     |
| `setSubscriptionGroup(...)`       | `POST /subscription/status/set`             |
| `client`                          | raw `braze-api` instance                    |

## Disclaimer

This is an independent, community-maintained project. It is not affiliated with,
endorsed by, or sponsored by Braze, Inc., NestJS, or the author's employer.
Braze and NestJS are trademarks of their respective owners.

## License

Copyright (c) 2026 Muhammad Sheraz
