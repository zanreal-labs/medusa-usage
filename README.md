# @zanreal/medusa-usage

Metered usage for Medusa v2: an append-only usage event log, batched ingestion,
deterministic deduplication, and totals you can re-derive a year later.

Medusa has no metering. Its
[subscriptions recipe](https://docs.medusajs.com/resources/recipes/subscriptions)
covers fixed-interval subscriptions and says nothing about usage, and there is
nothing on npm that fills the gap. This is that missing piece, and only that piece.

**It does not do billing.** It ends at "usage for this meter, this subject, this
window is N, here is an immutable snapshot of that answer". Turning N into an
order, an invoice or a payment is your application's business, and it always will
be - the moment a metering plugin starts having opinions about prices it stops
being usable by anyone whose pricing is not the one it imagined.

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Recording usage](#recording-usage)
- [Reading usage](#reading-usage)
- [Deduplication, in full](#deduplication-in-full)
- [Why ingestion is batched](#why-ingestion-is-batched)
- [Why quantities are whole numbers](#why-quantities-are-whole-numbers)
- [Windows are half-open](#windows-are-half-open)
- [Sinks](#sinks)
- [Options](#options)
- [Environment variables](#environment-variables)
- [Admin API](#admin-api)
- [Corrections](#corrections)
- [Running more than one instance](#running-more-than-one-instance)
- [What it deliberately does not do yet](#what-it-deliberately-does-not-do-yet)
- [Testing](#testing)
- [Generating a migration](#generating-a-migration)
- [License](#license)

## What it does

```text
  your code                 this plugin                        your code
  ---------                 -----------                        ---------
  record(event)  ->  validate, derive key, buffer
                              |
                              |  batch (size or age)
                              v
                          sink.write()  ->  append-only event log
                              |
  aggregate(window) ->  sink.aggregate()  ->  immutable snapshot  ->  invoice it
```

Four properties hold it together, and everything else is detail:

1. **The log is append-only.** No row is ever updated or deleted. A total computed
   in March comes out identical in November because it is computed from the same
   rows, not read from a counter that remembers what someone believed at the time.
2. **Keys are derived, never generated.** The same event, sent any number of
   times, has the same key and occupies at most one row. A retry, a redeploy or a
   replayed message cannot produce a second count.
3. **Ingestion batches.** A round trip per event is not affordable when the
   database is across the internet, so events are buffered and written in batches.
4. **The sink is a provider.** Where the log lives is a plugin option, the same
   way a fulfillment or notification provider is.

## Install

```bash
npm install @zanreal/medusa-usage
```

```ts
// medusa-config.ts
module.exports = defineConfig({
  plugins: [
    {
      resolve: "@zanreal/medusa-usage",
      options: {},
    },
  ],
})
```

That is the whole configuration. With no options it registers the built-in
Postgres sink under the id `postgres` and writes to the database Medusa already
has, so nothing external is needed to start metering.

Then run the migration:

```bash
npx medusa db:migrate
```

## Recording usage

From anywhere with the container:

```ts
import { USAGE_MODULE, UsageModuleService } from "@zanreal/medusa-usage/modules/usage"

const usage = container.resolve<UsageModuleService>(USAGE_MODULE)

await usage.record({
  meter: "api_request",     // what was consumed
  subject: customer.id,     // who consumed it, as an opaque id
  quantity: 1,              // how much, as a whole number
})
```

From a workflow, a subscriber or a route, run the workflow instead:

```ts
import { recordUsageWorkflow } from "@zanreal/medusa-usage/workflows"

await recordUsageWorkflow(container).run({
  input: {
    events: [
      {
        meter: "gb_egress",
        subject: subscriptionId,
        quantity: 1_500_000,          // bytes, not gigabytes: see below
        occurredAt: transfer.finishedAt,
        source: "gateway",
        properties: { region: "eu-central" },
        idempotencyKey: transfer.id,  // preferred whenever you have one
      },
    ],
  },
})
```

Or over HTTP, for a producer that is not inside this Medusa:

```bash
curl -X POST https://your-store/admin/usage/events \
  -H "x-medusa-access-token: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"events":[{"meter":"api_request","subject":"cus_01","quantity":1}]}'
```

### There is no built-in subscriber, and that is not an oversight

An obvious feature would be "map Medusa event X to usage event Y in config". It
cannot be built: Medusa binds a subscriber's events from a static `config` export
that is evaluated at plugin-load time, before the container - and therefore before
this plugin's options - exists. A subscriber cannot learn which events to listen
for from configuration.

So the mapping lives in your project, where it is three lines and where it belongs
anyway, since only you know what an order or a shipment means in units of your
meters:

```ts
// src/subscribers/meter-deliveries.ts
export default async function meterDeliveries({ event, container }) {
  await recordUsageWorkflow(container).run({
    input: {
      events: [{
        idempotencyKey: event.data.id,
        meter: "delivery",
        quantity: 1,
        subject: event.data.customer_id,
      }],
    },
  })
}

export const config = { event: "delivery.completed" }
```

## Reading usage

```ts
const snapshot = await usage.aggregate({
  meter: "api_request",
  subject: customer.id,
  from: new Date("2026-08-01T00:00:00Z"),   // inclusive
  to: new Date("2026-09-01T00:00:00Z"),     // exclusive
})
```

```jsonc
{
  "version": 1,
  "meter": "api_request",
  "subject": "cus_01",
  "from": "2026-08-01T00:00:00.000Z",
  "to": "2026-09-01T00:00:00.000Z",
  "properties": null,
  "total": 148_302,
  "eventCount": 148_302,
  "firstOccurredAt": "2026-08-01T00:04:11.000Z",
  "lastOccurredAt": "2026-08-31T23:51:07.000Z",
  "digest": "usnap_9f2c...",
  "sink": "postgres",
  "computedAt": "2026-09-01T02:00:00.000Z"
}
```

Store that object next to whatever you billed from it. Ask the same question in a
year and compare the two `digest` values: equal means the log behind the number is
byte-for-byte the same log. Different means something changed, and `total` against
`eventCount` tells you whether events were added, removed or restated.

`sink` and `computedAt` are outside the digest, so a snapshot re-derived from a
migrated log still matches. Everything else is inside it.

The events behind a number:

```ts
const page = await usage.listEvents({ meter, subject, from, to, limit: 100 })
```

That is the path for when someone disputes a bill. Showing them another total
computed the same way proves nothing; showing them the individual facts does.

## Deduplication, in full

Usage that double-counts is worse than usage that is missing. A number that is too
small is visible and complainable; a number that is quietly too large becomes an
invoice, and nobody finds out until a customer audits it. Every decision below
follows from that asymmetry.

An event's key is a SHA-256 over what the event **means**. Nothing ambient is
allowed into it - no random bytes, no `Date.now()`, no process id, no hostname, no
counter, no arrival order, no database sequence.

**With an explicit `idempotencyKey`:**

```text
sha256( "usg1" US "explicit" US meter US subject US idempotencyKey )
```

**Without one:**

```text
sha256( "usg1" US "derived" US meter US subject US occurredAt US quantity US source US properties )
```

where `US` is U+001F, `occurredAt` is the ISO 8601 instant at millisecond
precision in UTC, `quantity` is a decimal integer, and `properties` is canonical
JSON with its object keys sorted. The result is prefixed `uev_`, and it is also the
primary key of the row - so deduplication is enforced by the database's own
primary key, not by a read-then-write that another writer could slip between.

The pieces that make this safe rather than merely tidy:

- `meter`, `subject`, `source` and the explicit key are validated to contain no
  control characters, so U+001F cannot appear inside a field and the join is an
  injective encoding of its parts.
- Object key order cannot change a key, because `properties` is canonicalised
  before it is hashed.
- An absent property bag and an empty one hash identically, because they describe
  the same event.
- An explicit key is scoped to `(meter, subject)`. Metering `tokens_in` and
  `tokens_out` for the same request id gives two events, not one silently
  swallowing the other.
- `explicit` and `derived` are separate domains inside the hash, so the two spaces
  cannot collide.
- `usg1` pins the scheme. If the rules ever change, the prefix changes with them
  and old rows keep the keys they were written with. Nothing is ever rehashed;
  rehashing a log is the same as rewriting it.

The vectors are pinned in `src/lib/usage/dedupe.test.ts`. Those four hashes are the
contract: moving them would mean every key already in a production log stops
matching the key the same event derives today, and every one of those events would
be counted again.

**What the derived form costs.** Two genuinely distinct events that are identical
in every recorded field, down to the millisecond, collapse into one. That is a real
undercount and it is the deliberate side of the trade. If you can produce such
events, pass an `idempotencyKey`, or make them distinguishable with an ordinal in
`properties`, or combine them into one event with a larger `quantity` - which is
usually what was meant.

## Why ingestion is batched

`record` validates, keys and buffers, then returns. Batches leave when the buffer
fills (`batchSize`, default 500) or when its oldest event reaches
`flushIntervalMs` (default 5s), whichever comes first.

The reason is deployment reality rather than micro-optimisation: a Medusa talking
to a managed Postgres over the internet pays milliseconds of latency per round
trip, and a round trip per usage event puts a ceiling on how much you can meter
that has nothing to do with your traffic.

**The cost, stated plainly.** Buffered events live in memory. A `SIGKILL` loses
them. The exposure is bounded by three things - the flush interval, the batch
size, and a flush on graceful shutdown - and it errs in the safe direction of the
asymmetry above. If that is still unacceptable, set `flushMode: "immediate"` and
pay the round trip per call.

Two more properties worth knowing:

- **Back pressure, not dropping.** At `maxBufferedEvents` (default 10 000),
  `record` waits for a flush instead of growing the buffer. If that flush fails,
  the error reaches the caller - who can retry safely, because the keys are
  derived.
- **A failed batch goes back to the front of the queue**, ahead of anything newer,
  so a persistent sink failure cannot starve the oldest usage. Retrying is safe
  whatever the sink managed to persist before it failed.

A scheduled job (`usage-flush`, every minute) sits underneath all of it, for a
process that has gone quiet or never recorded anything at all.

## Why quantities are whole numbers

`quantity` must be a safe integer. Not taste: a sum of doubles depends on the order
the terms are added, so the same event log could produce two different totals on
two different days and both would be defensible. A price computed from that is not.

If what you meter is fractional, meter a smaller unit - bytes rather than
gigabytes, milliseconds rather than hours, thousandths of a credit rather than
credits - and record the count of those. Convert at the point where you decide what
it is worth, which is your code, not this plugin.

The Postgres sink stores `quantity` as `numeric` and sums it in the database, which
is exact at any size. Reading a total back out refuses rather than rounds if it has
grown beyond 2^53, because an approximate number that ends up priced is exactly the
failure this plugin exists to prevent.

## Windows are half-open

Every window is `[from, to)`: `from` inclusive, `to` exclusive. Consecutive periods
therefore tile without overlapping - August's `to` is September's `from`, and the
event on the boundary is counted exactly once, in September. A closed window would
count it in both, which is the same double-counting failure by a different route.

An inverted or zero-length window is refused rather than answered with zero. A zero
that came from a typo looks exactly like a customer who used nothing.

## Sinks

The sink is a module provider, exactly like a fulfillment or notification provider:
this module owns the interface and the lifecycle, and the implementation is named
in `medusa-config.ts`.

Why it is provider-shaped rather than a switch or a hardcoded table: where a usage
log lives is an infrastructure decision with an enormous range. A store metering
thousands of events a month wants them in the Postgres it already runs. A store
metering billions wants a column store built for it. Both are metering the same
thing, and neither should have to fork a plugin to say so.

The contract is three methods:

```ts
interface UsageSinkProvider {
  write(events: readonly UsageEvent[]): Promise<UsageSinkWriteResult>
  aggregate(query: UsageAggregateQuery): Promise<UsageAggregateResult>
  listEvents(query: UsageListQuery): Promise<UsageEventPage>
}
```

and six guarantees, written out in `src/lib/sink/types.ts`: append only; at most one
row per key; safe to retry a batch that failed halfway; filter on event time and
never on ingestion time; sum exactly; UTC throughout. There is no update and no
delete, and none should be added.

`src/providers/README.md` has a worked example of writing one. The built-in
Postgres sink is the reference implementation, and is about two hundred lines.

`@zanreal/medusa-usage-tinybird` is the second one, in a package of its own so
that nothing in here has to know what Tinybird is. It is worth reading if you are
writing a third: a column store gives none of the guarantees a primary key does,
and the package documents exactly which of them it rebuilds in the read path and
which stay eventual.

## Options

```ts
{
  resolve: "@zanreal/medusa-usage",
  options: {
    // Which sinks to register. Omit it entirely for the built-in Postgres sink
    // under the id "postgres".
    providers: [
      { resolve: "@zanreal/medusa-usage/providers/postgres", id: "postgres" },
    ],

    // Which registered sink to write to, by id. Only needed with more than one:
    // with a single sink there is nothing to disambiguate, and with several the
    // plugin refuses to guess rather than choosing which log is the real one.
    sink: "postgres",

    // "buffered" (default) or "immediate".
    flushMode: "buffered",

    batchSize: 500,           // events per write, and the size flush trigger
    flushIntervalMs: 5000,    // the age flush trigger
    maxBufferedEvents: 10000, // ceiling before record applies back pressure
    maxEventsPerCall: 1000,   // most events one record call may carry
  },
}
```

Every option is validated at boot. A plugin with nowhere to put events is not a
quiet no-op - it is silent data loss - so misconfiguration fails the boot rather
than disabling the plugin.

## Environment variables

| Variable           | Default     | What it does                        |
| ------------------ | ----------- | ----------------------------------- |
| `USAGE_FLUSH_CRON` | `* * * * *` | Schedule of the buffer flush job.   |

It is an environment variable rather than a plugin option because Medusa evaluates
a scheduled job's `config.schedule` at plugin-load time, before the container - and
therefore this plugin's options - exists.

## Admin API

Every route is under `/admin` and authenticated by Medusa's default. A machine
producer is a first-class caller and uses an admin API key, which can be rotated
and revoked; there is deliberately no unauthenticated ingestion route, because an
unauthenticated way to write to a billing input is a way for anyone to change
someone's bill.

| Method | Path                     | What                                       |
| ------ | ------------------------ | ------------------------------------------ |
| `GET`  | `/admin/usage`           | Sink, ingestion settings, buffer, last flush |
| `POST` | `/admin/usage/events`    | Record one event or a batch. 202.          |
| `GET`  | `/admin/usage/events`    | The events behind an aggregate, paged.     |
| `GET`  | `/admin/usage/aggregate` | A snapshot for one meter and window.       |

`POST /admin/usage/events` returns the derived key of every event, which is what
makes a client retry safe: the same body returns the same keys and the log gains
nothing the second time.

`GET /admin/usage` is where to look first when a meter looks wrong. A rising
`buffered` with a `last_flush_error` is a sink problem. A `buffered` of zero with
no usage arriving is a producer problem.

## Corrections

You do not edit a usage event. If usage was recorded wrongly, append its reversal:

```ts
await usage.record({
  meter: "api_request",
  subject: customer.id,
  quantity: -12,
  occurredAt: theOriginalInstant,
  properties: { correction_of: originalKey },
})
```

The window's total moves, `eventCount` goes up rather than down, and the digest
changes - all of which is what an auditor should see. A silently edited row is not.

## Running more than one instance

Each process buffers its own events, and `aggregate` flushes only the buffer of the
process serving the request. So a window should be closed before it is snapshotted,
by at least `flushIntervalMs`. Billing yesterday's usage some time after midnight is
fine; billing the last five seconds of it is not.

This is a property of running several processes, not of this plugin, and pretending
otherwise would be worse than saying it. Deduplication is unaffected: keys are
global and the sink keeps one row per key however many processes wrote it.

## What it deliberately does not do yet

This is the first release, and it stops at the event log on purpose. Nothing below
is designed yet, and each one is a decision that should be made against a real
pricing model rather than guessed at:

- **Billing periods.** Anchors, proration, calendar versus rolling windows, and
  what happens when a subscription changes mid-period. Today you pass explicit
  `from` and `to`.
- **Rating.** Tiers, package pricing, included allowances, minimum commitments,
  currency. Today you get a count and price it yourself.
- **Limits and quotas.** Refusing or throttling a request once a subject has passed
  an allowance, which needs a fast read path that the aggregate query is not.
- **An admin UI.** A screen that only rendered today's endpoints would need
  redesigning the moment periods and rating exist.
- **Rollups.** Aggregating from raw events stays honest indefinitely, but not fast
  indefinitely. When it stops being fast the answer is a materialised rollup that
  is re-derivable from the log, not a mutable counter.

## Testing

```bash
pnpm test
```

Unit tests throughout, with no database. What is worth asserting here lives above
the database - what a key is derived from, what the buffer does with a batch that
fails, whether a snapshot is taken over a flushed buffer - and all of it is
observable against fakes.

The one thing fakes cannot cover is whether Postgres really behaves as the sink
assumes. That was verified by hand against Postgres 16 while the migration was
written: the multi-row `INSERT ... ON CONFLICT DO NOTHING` really does return only
the rows it appended, `sum()` over `numeric` is exact, `properties @> '{...}'`
matches containment and skips rows whose properties are null, and the
`("occurred_at", "id") > (?, ?)` cursor resumes exactly where the previous page
ended. The unit tests pin that the provider keeps generating those statements.

## Generating a migration

Requires a local Postgres. Always generate rather than hand-writing, so
`.snapshot-medusa-usage.json` stays authoritative. CI enforces this: it regenerates
against a throwaway Postgres and fails on a dirty tree.

**Use this exact container name and port.** They are recorded here so the next
person reuses them rather than hunting for a free port - two people independently
picking "the next free port" is how one of them ends up deleting the other's
container.

```bash
# 1. A throwaway Postgres, named after this repo, on this repo's port.
docker run -d --name usage-migrate-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=medusa_usage_dev \
  -p 55437:5432 postgres:16-alpine

# 2. .env (not committed; see .env.template)
cat > .env <<'ENV'
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_HOST=localhost
DB_PORT=55437
DB_NAME=medusa_usage_dev
DATABASE_URL=postgres://postgres:postgres@localhost:55437/medusa_usage_dev
ENV

# 3. Generate, then commit BOTH the migration and the updated snapshot.
pnpm exec medusa plugin:db:generate

# 4. Tear down in the same sitting, BY NAME. Never by `--filter publish=<port>`:
#    that matches whatever else happens to be on the port, including another
#    repo's container.
docker rm -f usage-migrate-pg && rm -f .env
```

Create and destroy it within the same task, so it never outlives the migration it
was for.

## License

MIT. See [LICENSE](./LICENSE).
