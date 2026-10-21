# @ota/agoda-connectivity

Agoda supplier adapter for the C-end OTA hotel sales system.

One interface, two implementations:

| mode   | class              | what it is                                                        |
| ------ | ------------------ | ----------------------------------------------------------------- |
| `mock` | `AgodaMockAdapter` | deterministic in-process simulator of the Agoda Demand API         |
| `live` | `AgodaLiveAdapter` | the real Agoda Demand API over HTTPS, XML request/response bodies |

**Demand side only.** We PULL Agoda inventory and resell it. The supply
side (`OTA_HotelAvailNotifRQ`, `OTA_HotelRatePlanNotifRQ`,
`OTA_HotelResModifyRQ`) is intentionally not implemented.

```ts
import { createAgodaAdapter } from '@ota/agoda-connectivity';

const adapter = createAgodaAdapter({ mode: 'mock' }); // or { mode: 'live', ... }
```

## The flow: Search → Precheck → Book

The parameters (dates, rooms, occupancy, currency, guest country) must be
**identical** across the three calls — Agoda rejects "parameter drift".
`SupplierPrecheckInput` and `SupplierBookingInput` carry a
`contextFingerprint` for that reason: the adapter passes it through
unchanged and never recomputes it.

* **Search** (`searchHotels`) — hotel summaries with the cheapest stay total.
* **Availability** (`getAvailability`) — room level quotes per room type × rate plan.
* **Precheck** (`precheck`) — re-validates one offer. `priceChanged === true`
  means the supplier re-priced it.
* **Book** (`book`) — creates the booking. Agoda answers `processing: true`
  while it still reserves the allotment: **that is not a confirmation**.
  Poll `getBooking()` until `status === 'CONFIRMED'` (the business layer
  polls for up to 30 minutes).

## Error codes

Every failure is an `AppError` from `@ota/core`:

`SUPPLIER_TIMEOUT`, `SUPPLIER_RATE_LIMITED`, `SUPPLIER_AUTH_ERROR`,
`SUPPLIER_ERROR`, `ROOM_UNAVAILABLE`, `PRICE_CHANGED`, `BOOKING_REJECTED`,
`DUPLICATE_BOOKING`, `CONFIG_ERROR`, `HOTEL_NOT_FOUND`, `NOT_FOUND`,
`VALIDATION_ERROR`.

## Timeouts — one per endpoint, never one global value

| endpoint          | default |
| ----------------- | ------- |
| content / search / detail / cancel | 30s |
| **precheck**      | **60s** |
| **booking**       | **120s** |

Override per endpoint with `config.timeouts` (keys: `content`, `search`,
`precheck`, `booking`, `detail`, `cancel`). Every call carries an
`AbortSignal`, so a hung upstream connection can never pin the process.

## Rate limiting

`config.rateLimitRpm` / `config.rateLimitBurst` drive a client side token
bucket. The thresholds are only disclosed by Agoda during onboarding, so
they are configuration, not constants. Exceeding the quota raises
`SUPPLIER_RATE_LIMITED`; an upstream 429 is mapped to the same code.

## Retries — and why `book()` is never retried

The transport retries **safe reads** (search, availability, detail, cancel)
with exponential backoff + jitter, and only for retryable conditions
(network error, timeout, 429, 5xx).

**The booking call is never retried by the transport.** A blind retry of a
booking POST can create a *second* reservation at Agoda while the first one
actually succeeded — a double booking we would pay for. The business layer
owns that decision, because only it knows the idempotency key and whether a
replay is safe.

A circuit breaker (`CircuitBreaker` from `@ota/core`) wraps every upstream
call: while Agoda is unhealthy we fail fast instead of burning the
customer's latency budget.

## The mock

The mock is what the whole system runs against in dev/CI, so it reproduces
the awkward parts of the real API rather than a happy path:

* 12 hotels (3–5 stars, city + resort, 2–4 room types each);
* **price drift** between search and precheck — deterministic, driven by
  `priceDriftRate` (default `0` = stable);
* **sell-out** — an offer can disappear before precheck (`sellOutRate`,
  `soldOutOfferIds`);
* **processing** — `book()` answers `processing: true` and converges to
  `CONFIRMED` after `processingPolls` polls;
* **duplicate rejection** — a second booking for the same lead guest +
  hotel + overlapping dates is rejected, even though we always send
  `allowDuplication: true`;
* **rate limiting**, **timeouts** and **5xx** — injectable, so the retry /
  circuit breaker path is exercised offline;
* **cancellation** — honours the rate's policy and returns
  `penaltyAmount` / `refundAmount`; cancelling twice is idempotent.

Everything is deterministic: the same seed produces the same catalogue, the
same prices and the same drift decisions. `Math.random()` is never used for
a business value.

```ts
const mock = new AgodaMockAdapter({ seed: 42, priceDriftRate: 1 });
mock.failNext(1, 'timeout'); // the next call raises SUPPLIER_TIMEOUT
```

The mock speaks the **same XML dialect** as the live adapter: it encodes
its responses and decodes them back through `AgodaXmlCodec`, so a codec bug
shows up in dev instead of in production.

## The XML layer

`src/xml/schema.ts` holds **every** element name, attribute name and
endpoint path. The exact Agoda names are only confirmed when the welcome
package arrives, so the mapping lives in one file: correcting the
integration is a one-file edit.

* `src/xml/codec.ts` — `AgodaXmlCodec`: encodes requests, decodes responses
  into the `Supplier*` DTOs. User controlled text (guest names, special
  requests) is XML escaped.
* `src/xml/parse.ts` — defensive helpers: they never throw, never produce
  `NaN` money, and reject dates that are not `YYYY-MM-DD`.
* `src/xml/builder.ts` — the tiny XML writer with explicit escaping.
* `src/xml/fixtures/**` — realistic request/response samples used by the tests.

Money is integer minor units end to end; decimals are converted with string
arithmetic, never through a float.

## Live adapter notes

* Authentication: HTTP Basic (`username`/`password`) **plus** an `X-Api-Key`
  header, over HTTPS.
* Missing credentials fail fast with `AppError('CONFIG_ERROR', ...)`. They
  are never required at import time, so the module can be imported in dev
  and in mock mode.
* Every upstream call is logged with endpoint, duration, status and a
  correlation id. **Guest email and phone are never logged verbatim**, and
  request bodies are not logged at all.

## Tests

```bash
pnpm --filter @ota/core build          # the adapter imports @ota/core from dist
pnpm --filter @ota/agoda-connectivity typecheck
pnpm --filter @ota/agoda-connectivity test
```

The suite runs **fully offline**: the live adapter is exercised through an
injected `fetch`, never a real network call.
