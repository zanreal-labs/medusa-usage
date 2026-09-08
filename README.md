# @zanreal/medusa-usage

Metered usage for Medusa v2: an append-only usage event log, batched ingestion,
deterministic deduplication, billing periods, rating, and a frozen result you can
re-derive a year later.

Full documentation, in English and Polish, is published at
<https://zanreal.com/docs/oss/medusa-usage> and authored in [`docs/`](./docs).

Medusa has no metering. Its
[subscriptions recipe](https://docs.medusajs.com/resources/recipes/subscriptions)
covers fixed-interval subscriptions and says nothing about usage, and there is
nothing on npm that fills the gap. This is that missing piece, and only that piece.

**It does not do invoicing.** It ends at "period P, for subject S, over
`[from, to)`, rated to T, and here is the frozen breakdown". Turning that into a
document, a tax calculation, a payment or a dunning schedule is your
application's business, and it always will be. The rates themselves are
configuration, not code: the moment a metering plugin has an opinion about what a
unit is worth, it stops being usable by anyone whose pricing is not the one it
imagined.

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Recording usage](#recording-usage)
- [Reading usage](#reading-usage)
- [Deduplication, in full](#deduplication-in-full)
- [Why ingestion is batched](#why-ingestion-is-batched)
- [Why quantities are whole numbers](#why-quantities-are-whole-numbers)
- [Windows are half-open](#windows-are-half-open)
- [Billing periods](#billing-periods)
- [Rating](#rating)
- [The frozen result](#the-frozen-result)
- [A period that closes while events are still arriving](#a-period-that-closes-while-events-are-still-arriving)
- [Turning a closed period into an invoice](#turning-a-closed-period-into-an-invoice)
- [Sinks](#sinks)
- [Options](#options)
- [Environment variables](#environment-variables)
- [Admin API](#admin-api)
- [Admin UI](#admin-ui)
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
  aggregate(window) ->  sink.aggregate()  ->  immutable snapshot
                              |
  closePeriod(P)   ->  aggregate + rate + freeze  ->  stored result  ->  invoice it
                              |
                              +-> usage_period.closed  ->  your subscriber
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
5. **A closed period is frozen.** Closing rates the usage once and stores the
   answer. An invoice is built from that stored row, never from a live query,
   because a live query answers "what does the log say now" and an invoice needs
   "what did we charge".

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

## Billing periods

A period is a subject and a half-open window. That is the entire model: it is not
a subscription, it carries no price, and it does not know what a month is.

```ts
const period = await usage.openPeriod({
  subject: customer.id,
  startsAt: new Date("2026-08-01T00:00:00Z"),   // inclusive
  endsAt: new Date("2026-09-01T00:00:00Z"),     // exclusive
})
```

`[start, end)`, like every other window here, so consecutive periods tile without
overlapping and an event on the boundary is billed exactly once, in the later
period. A closed window would bill it in both, which is the double-charge this
package exists to make impossible.

**A period's id is derived, not generated.** It is a SHA-256 over the subject and
the two instants, so opening the same period twice opens one period and the second
call is a no-op the primary key refuses. The consequence worth knowing: a boundary
that moves by one millisecond is a different period, with a different id, which can
be closed and billed separately. Generate your boundaries deterministically, not
from whatever `new Date()` said when a job happened to run.

**Nothing closes by itself.** This package has no scheduler for periods and should
not have one, because only you know whether your cycle is calendar months, thirty
days from signup, or something your finance team invented. Opening a period is a
statement that a window exists; closing it is a decision you make.

### The subscription is free, and that shapes the model

There is no plan price here, no base fee, no minimum commitment and no proration,
and there is nowhere to put one. A period's charge is the usage inside it, rated
and summed. A customer who consumed nothing owes nothing, and that falls out of the
arithmetic rather than out of a special case.

So a subscription, in this model, is only the thing that decides when a period
ends. It costs nothing, and it is your data, not this package's.

## Rating

A rate is configuration. Set it in `medusa-config.ts` and nothing about your meters
or your prices is compiled into this package:

```ts
options: {
  billing: {
    currency: "PLN",
    rates: [
      // 12 grosze per 10 000 requests, with the first million each period free.
      { meter: "api_request", unitAmount: 12, perUnits: 10_000, includedUnits: 1_000_000 },
      // 5 grosze per gigabyte, from the first one.
      { meter: "gb_egress", unitAmount: 5 },
    ],
  },
}
```

The arithmetic, in full:

```text
chargeable = total <= 0 ? total : max(total - includedUnits, 0)
amount     = trunc(chargeable * unitAmount / perUnits)
```

**Money is whole numbers of minor units**, for exactly the reason quantities are
whole numbers: a sum of doubles depends on the order the terms are added, so one
period could rate to two different amounts on two different days and both would be
defensible. One of them would be on an invoice. `unitAmount` is grosze, cents or
pence, as every payment API on earth takes it.

**The multiplication and the division are done in `BigInt`**, so the intermediate
product cannot overflow into an approximation on its way to a division that would
have made it exact again. An amount too large to be a safe integer is refused
rather than rounded.

**`perUnits` is why a rate has a denominator.** It defaults to 1, which is the
plain "so much per unit" that most rates are. It exists because without it this
package would quietly assume every meter is worth at least one minor unit per unit
consumed, and a meter counting API requests is not. Priced at a hundredth of a
grosz per request, the alternatives would be to invent a meter that counts
thousands of requests, losing the raw count the audit path exists to show, or to
price in fractions, which is the thing this package refuses to do.

**The division truncates toward zero**, so rating a credit is exactly the negation
of rating the charge it reverses. Flooring would break that, and a correction that
does not undo the thing it corrects is worse than no correction. The cost is one
dropped fraction of a minor unit per meter per period, in the customer's favour on
a charge. A fraction of a grosz cannot be invoiced anyway.

**An allowance forgives consumption; it does not create it.** A period whose net
total is negative, because corrections outweighed usage, passes through untouched
rather than being clamped to zero by an allowance it never used. Clamping there
would silently swallow money the customer is owed.

**What is deliberately not here:** tiers, volume breaks, per-subject or per-plan
overrides, dimension-priced rates, currency conversion. Each is a real pricing
model, none can be designed against products that do not exist yet, and a rate card
keyed by anything other than the meter would have to become a query language.

Configuring no `billing` block at all is supported and means the plugin meters
without rating. Recording, aggregating and listing are unaffected; only closing a
period refuses, and it refuses by name rather than rating everything to zero. A
period that came to nothing because nobody configured a price looks identical to a
period in which nothing was consumed, and those two must not be confused.

## The frozen result

```ts
const { result, alreadyClosed } = await usage.closePeriod({ periodId: period.id })
```

Every meter on the rate card is aggregated over the period's window, rated, and
written as a line - including the meters that came to nothing, so the result proves
each one was looked at rather than leaving you to wonder whether a missing line
means zero usage or a forgotten rate.

```jsonc
{
  "version": 1,
  "periodId": "ubp_4ddb0a00...",
  "subject": "cus_01",
  "from": "2026-08-01T00:00:00.000Z",
  "to": "2026-09-01T00:00:00.000Z",
  "currency": "PLN",
  "lines": [
    {
      "meter": "api_request",
      "quantity": 1_234_567,
      "eventCount": 1_234_567,
      "firstOccurredAt": "2026-08-01T00:04:11.000Z",
      "lastOccurredAt": "2026-08-31T23:51:07.000Z",
      "usageDigest": "usnap_9f2c...",
      "includedUnits": 1_000_000,
      "unitAmount": 12,
      "perUnits": 10_000,
      "chargeableQuantity": 234_567,
      "amount": 281
    }
  ],
  "total": 281,
  "eventCount": 1_234_567,
  "digest": "uper_dd025dc6...",
  "sink": "postgres",
  "closedAt": "2026-09-01T02:00:00.000Z"
}
```

**Every line explains itself.** The quantity, the event count, the first and last
instants inside the window, the rate that was applied and the digest of the usage
snapshot it was rated from. An invoice line nobody can justify is worse than no
invoice, so the amount never appears without the arithmetic that produced it, and
the arithmetic never appears without a pointer back into the log.

**It is stored, unlike a usage snapshot.** A snapshot is a value, computed on
demand. A result is a row, written once. The moment a number is billed it stops
being a question about the log and becomes a fact about what was charged, and those
two can drift. So the result is frozen at the instant of closing and read back
verbatim afterwards. Build your document from this row and never from a live query.

The row lives in the Medusa database whatever sink the event log uses. Periods are
this module's own state, not usage, and the sink contract is three methods over an
append-only log and should stay that way. In a Tinybird deployment that means
events in Tinybird, periods and their results in Postgres.

### Closing twice does not bill twice

The result is inserted under the period's own derived id, and the insert ignores a
conflict:

```sql
insert into "usage_period_result" (...) values (...) on conflict ("id") do nothing returning "id"
```

Nothing is read before that write, so there is no window for a retried job or a
second worker to slip through. The first call appends the row and reports
`alreadyClosed: false`. Every call after it appends nothing and reports the stored
result with `alreadyClosed: true` - the first answer, not a fresh one, even if the
log has moved since.

**`alreadyClosed` is the flag to key an invoice off, and only that.** It is the one
thing that cannot be false twice.

The same guarantee reaches your subscribers, because closing through the workflow
emits `usage_period.closed` only on the call that actually closed the period:

```ts
import { closeBillingPeriodWorkflow } from "@zanreal/medusa-usage/workflows"

await closeBillingPeriodWorkflow(container).run({ input: { periodId } })
```

So a subscriber that creates an invoice does not have to deduplicate. It is not
called twice.

### Three states, and telling them apart

| What you see                            | What it means                          | What to do          |
| --------------------------------------- | -------------------------------------- | ------------------- |
| no result (`null`)                       | the period is not closed yet           | do not bill it      |
| `total: 0`, `eventCount: 0`              | closed, and provably empty             | issue no invoice    |
| `total: 0`, `eventCount > 0`             | closed, all of it inside the allowance | issue no invoice    |
| `total > 0`                              | closed, and this is what is owed        | invoice it          |
| `total < 0`                              | corrections outweighed the usage       | your call: a credit |

A free subscription produces the second and third rows routinely. They are not edge
cases, and the right response to both is no invoice at all rather than an invoice
for zero.

### Proving it later

```ts
const check = await usage.verifyPeriod(periodId)
// { matches: true, storedTotal: 281, recomputedTotal: 281, totalDelta: 0, lines: [...] }
```

The period is rated again from the log and the two digests are compared. `matches`
is true when the log behind the number is byte-for-byte the log it was billed from.
The rates used are the ones recorded on the stored lines, never the ones in your
configuration today, so raising a price cannot make every past period fail to
verify, and lowering one cannot quietly claim an old invoice was wrong.

Nothing is written, whatever it finds.

## A period that closes while events are still arriving

Late events are real, and the answer here is a decision rather than an accident.

**An event that arrives after its period closed is still recorded, in the period it
occurred in, and it does not change what was billed.** The log accepts it, because
the log accepts everything and filters on `occurredAt`. The frozen result does not
move, because a number that has been invoiced must not.

So the difference surfaces in exactly one place: `verifyPeriod` stops matching, and
says by how much, per meter. That is the intended behaviour and not a fault
condition. What you do about it is a business decision this package cannot make, but
there is only one thing to do that keeps the log honest:

**Carry the difference into an open period, as usage.** Record a correcting event
with an `occurredAt` inside the currently open window, pointing at what it is
catching up:

```ts
await usage.record({
  meter: "api_request",
  subject: customer.id,
  quantity: 4_120,                              // what August turned out to have missed
  occurredAt: new Date(),                       // inside September, which is still open
  properties: { late_for_period: closedPeriodId },
})
```

August's invoice stands, September's includes the catch-up, and both are derivable
from the log. Reopening August would mean editing something a customer has already
been sent, which this package has no operation for and should not acquire one.

**Reduce how often it happens with `closeDelayMs`.** It is a floor on when a period
may be frozen, expressed as milliseconds after the window ends:

```ts
billing: { currency: "PLN", closeDelayMs: 6 * 60 * 60 * 1000, rates: [...] }
```

Zero, the default, allows closing the moment the window is over. Raise it to
whatever your slowest producer needs. How late a producer can be is a property of
that producer and of the sink underneath it, not of this package, so there is no
default that would be right for everyone - but note that closing a period at the
stroke of midnight is optimistic in every deployment that has more than one process
buffering events, and that the plugin already refuses to close a period whose window
has not ended at all.

## Turning a closed period into an invoice

This is where the package stops and your application starts. It is deliberately a
short piece of code, and none of it belongs in here:

```ts
// src/subscribers/invoice-closed-period.ts
import { PERIOD_CLOSED_EVENT } from "@zanreal/medusa-usage/workflows"
import { USAGE_MODULE, UsageModuleService } from "@zanreal/medusa-usage/modules/usage"

export default async function invoiceClosedPeriod({ event, container }) {
  const usage = container.resolve<UsageModuleService>(USAGE_MODULE)
  const result = await usage.getPeriodResult(event.data.id)

  // A free subscription with no usage owes nothing, and nothing is what it gets.
  if (!result || result.total === 0) {
    return
  }

  await yourInvoicingService.create({
    customerId: result.subject,
    currency: result.currency,
    // One invoice line per meter, described in your words, priced in ours.
    lines: result.lines
      .filter((line) => line.amount !== 0)
      .map((line) => ({
        description: describeMeter(line.meter, line),
        quantity: line.chargeableQuantity,
        unitAmount: line.unitAmount,
        amount: line.amount,
      })),
    total: result.total,
    // Keep the digest. It is what proves the total, months from now.
    reference: { periodId: result.periodId, digest: result.digest },
  })
}

export const config = { event: PERIOD_CLOSED_EVENT }
```

Everything that is missing from that is missing on purpose: tax, invoice numbering,
the document itself, the payment, what happens when the payment fails, and what any
of it is called in your customer's language. This package cannot know any of it, and
a package that guessed would be wrong for everyone except the deployment it was
guessed for.

Store the `digest` beside whatever you billed. It is the one string that turns
"trust us" into "here is the log".

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

    // What usage is worth. Omit it entirely and the plugin meters without rating:
    // everything except closing a period works exactly as it did before.
    billing: {
      // One currency for the whole card, because a period rates to one total and
      // a total in two currencies is not a number. ISO 4217, carried onto every
      // result and never resolved against anything.
      currency: "PLN",

      // How long after a period ends before it may be closed. Zero allows closing
      // the moment the window is over.
      closeDelayMs: 0,

      rates: [
        {
          meter: "api_request",   // matched byte for byte against the recorded meter
          unitAmount: 12,         // whole minor units, per `perUnits` of the meter
          perUnits: 10_000,       // defaults to 1
          includedUnits: 1_000_000, // forgiven each period, defaults to 0
        },
      ],
    },
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
| `GET`  | `/admin/usage/periods`   | Periods, newest first. Filter by subject, status, end. |
| `POST` | `/admin/usage/periods`   | Open a period. Idempotent.                 |
| `GET`  | `/admin/usage/periods/:id` | The period, and its frozen result if it has one. |
| `POST` | `/admin/usage/periods/:id/close` | Rate it and freeze it. Idempotent. |
| `GET`  | `/admin/usage/periods/:id/verify` | Rate it again from the log and compare. |

`POST /admin/usage/events` returns the derived key of every event, which is what
makes a client retry safe: the same body returns the same keys and the log gains
nothing the second time.

`POST /admin/usage/periods/:id/close` is safe to retry for the same reason:
`already_closed` says whether this call was the one that rated the period, and the
body carries the stored result either way. It runs the workflow, so a host's
subscribers hear about the close exactly once.

`GET /admin/usage` is where to look first when a meter looks wrong. A rising
`buffered` with a `last_flush_error` is a sink problem. A `buffered` of zero with
no usage arriving is a producer problem. Its `rates` field is the configured rate
card, or null when the plugin only meters - which is the first thing to check when
a period refuses to close.

The listing route takes the query a billing run makes:
`GET /admin/usage/periods?status=open&ended_before=<now>` is every period that is
over and has not been billed.

## Admin UI

One route, **Usage**, in the admin sidebar at `/app/usage`. It ships with the
plugin and needs no configuration: register the plugin and the screen is there.

It answers three questions and deliberately nothing else.

- **Is anything being recorded at all?** Which sink is in effect, whether the last
  flush worked, what is waiting in the buffer, and - separately, because it is a
  different question - whether any usage exists on each meter in the chosen window.
  A healthy pipe with nothing in it is a normal state, and so is a meter with a
  total while the buffer is failing to flush.
- **What did one subject consume?** A subject and a half-open UTC window at the
  top, a row per meter with the quantity, the event count and the snapshot digest,
  and the individual events behind any of them one click away. That last one is the
  audit path: what settles a dispute is the facts the total was summed from, not
  another total computed the same way.
- **Is this period closed, and does it verify?** The periods list, with the reason
  each open one can or cannot be closed yet - a missing rate card, or a window that
  is still accruing - so a billing run does not discover it as a rejected request.
  Opening a period shows the frozen result and its digest, and offers `close`
  behind a confirmation and `verify` without one.

Every total, amount and count on the screen is rendered exactly as the endpoints
above sent it; amounts are converted from minor currency units by moving the
decimal point through the digits, never by dividing, so a figure there cannot
drift from the figure that was billed. There are no charts, the screen cannot open
a period - which periods exist is the one thing this package cannot decide for
you - and it does not enumerate meters, because the plugin records whatever meter
name a producer sends and keeps no registry of them. The meter list is the rate
card plus whatever you type in.

The screen talks to the same origin the admin is served from. A plugin's admin
extensions are built into a bundle before a host ever sees them, so a backend on a
separate origin is a deployment it cannot be pointed at.

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

A correction whose `occurredAt` falls inside a period that has already been closed
does not change what that period was billed: the frozen result is what was charged
and it does not move. It will make `verifyPeriod` stop matching, which is how you
find out. See [A period that closes while events are still
arriving](#a-period-that-closes-while-events-are-still-arriving) for what to do
about it.

## Running more than one instance

Each process buffers its own events, and `aggregate` flushes only the buffer of the
process serving the request. So a window should be closed before it is snapshotted,
by at least `flushIntervalMs`. Billing yesterday's usage some time after midnight is
fine; billing the last five seconds of it is not.

This is a property of running several processes, not of this plugin, and pretending
otherwise would be worse than saying it. Deduplication is unaffected: keys are
global and the sink keeps one row per key however many processes wrote it.

The same applies to closing a period, which is a snapshot with money attached:
`billing.closeDelayMs` is where you say how long to wait, and closing at the stroke
of midnight is optimistic in any deployment with more than one process buffering
events.

## What it deliberately does not do yet

Nothing below is designed yet, and each one is a decision that should be made
against a real pricing model rather than guessed at:

- **Anything above a per-meter rate.** Tiers, volume breaks, minimum commitments,
  proration when a period is cut short, per-subject or per-plan overrides, and
  currency conversion. What exists today is a whole-number rate per meter, an
  optional allowance, and a sum.
- **Invoicing, tax and payment.** Not "not yet" but "not ever": see the section on
  turning a closed period into an invoice for where the line is and what it costs
  you to be on the other side of it.
- **Scheduled closing.** Which periods exist, and when, is the one thing a package
  that does not know your billing cycle cannot decide. Open them and close them
  from a job of your own.
- **Limits and quotas.** Refusing or throttling a request once a subject has passed
  an allowance, which needs a fast read path that the aggregate query is not.
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

## Releasing

Publishing happens only from
[`.github/workflows/release.yml`](./.github/workflows/release.yml), and there is
no second path. npm **provenance** is a signed statement about where a tarball
was built and from which commit, and only a cloud CI run holding an OIDC
identity can produce one. An `npm publish` from a laptop would put a version on
npm carrying no provenance, and a published version cannot be replaced
afterwards, only deprecated. `publishConfig.provenance` in `package.json` makes
that local publish fail rather than quietly succeed without it.

To cut a release:

1. Move the `## [Unreleased]` entries in [CHANGELOG.md](./CHANGELOG.md) under a
   heading for the new version, dated.
2. Bump `version` in `package.json` on `main`.
3. Publish a GitHub Release whose tag is `v<version>`, exactly.

The workflow refuses to publish when the tag disagrees with `package.json`, or
when that version is already on the registry. A release marked as a prerelease
on GitHub publishes under the `next` dist-tag, so
`npm install @zanreal/medusa-usage` never resolves to a release candidate.

Authentication is an `NPM_TOKEN` repository secret: a granular access token with
write permission on this package. npm's trusted publishing (OIDC, with nothing
stored in GitHub) cannot cover the *first* publish, because npmjs.com only offers
the trusted publisher form on a package that already exists. Once the first
version is up, add one under the package's settings on npmjs.com - GitHub
Actions, owner `zanreal-labs`, repository `medusa-usage`, workflow `release.yml`,
environment `npm` - and then delete the `NPM_TOKEN` secret. The workflow needs no
edit for that: npm attempts the OIDC exchange first and falls back to the token
only when the exchange fails.

## License

MIT. See [LICENSE](./LICENSE).
