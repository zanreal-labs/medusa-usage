import { model } from "@medusajs/framework/utils";

/**
 * The append-only usage log, as the built-in Postgres sink stores it.
 *
 * ## Why this table belongs to the module and not to the provider
 *
 * Medusa generates migrations per module, not per provider, so a provider cannot
 * ship a table of its own. This is therefore the Postgres sink's table living in
 * the module's migration folder, and nothing else in the plugin reads or writes
 * it: every path goes through the configured sink. A deployment that configures a
 * different sink gets this table created and left empty, which is the price of the
 * framework's migration model and is stated here so nobody wonders.
 *
 * ## The primary key is the deduplication key
 *
 * `id` is not a generated identifier. It is `UsageEvent.key` - a SHA-256 over what
 * the event means (see `src/lib/usage/dedupe.ts`) - so the row's identity and the
 * event's identity are the same thing.
 *
 * That collapses deduplication into the one mechanism a database is best at:
 * the primary key. An insert of an event that is already here conflicts, and the
 * conflict is ignored. There is no read-then-write, so there is no window between
 * the read and the write for a concurrent writer to slip through, and no second
 * uniqueness rule that could disagree with the first.
 *
 * A consequence worth stating: `createUsageEvents`, generated onto the module
 * service by `MedusaService`, is not the ingestion path and must not be used as
 * one. It would mint an id of its own and defeat all of the above. Ingestion is
 * `UsageModuleService.record`.
 *
 * ## Nothing here is changed after it is written
 *
 * There is no status, no correction flag and no counter. A number computed from
 * these rows in March has to come out the same in November, which is only true if
 * the rows are only ever appended. A mistake is corrected by appending its
 * reversal - a second event, negative `quantity` - never by editing the first.
 * The columns Medusa adds automatically say the same thing: `created_at` is when
 * the sink accepted the row, `updated_at` should never differ from it, and
 * `deleted_at` should never be set.
 */
const UsageEvent = model
  .define("usage_event", {
    /**
     * When the consumption happened, in the source system. The only column
     * aggregation filters on, so a batch that arrives late still lands in the
     * period it belongs to.
     */
    occurred_at: model.dateTime(),
    /** The deduplication key. See the note above. */
    id: model.text().primaryKey(),
    /** What was consumed. An opaque host string. */
    meter: model.text(),
    /**
     * Dimensions, for filtering an aggregate. Part of the deduplication key, so
     * two events differing only here are two events.
     */
    properties: model.json().nullable(),
    /**
     * How much, as a whole number of the meter's smallest unit.
     *
     * A `bigNumber` rather than a `number` because a `number` is a 32-bit integer
     * column, and a meter counting bytes or milliseconds passes two billion in a
     * single event without trying. Numeric arithmetic in Postgres is exact at any
     * size, so summing it cannot round; the module refuses to hand back a total
     * too large for exact integer arithmetic in JavaScript rather than quietly
     * approximating it.
     */
    quantity: model.bigNumber(),
    /** Which producer reported it. Part of the deduplication key. */
    source: model.text().nullable(),
    /** Who consumed it. An opaque host identifier this plugin never resolves. */
    subject: model.text(),
  })
  .indexes([
    // The aggregate query for one subject on one meter: the invoice-shaped
    // question, and the only one on the hot path.
    { on: ["meter", "subject", "occurred_at"] },
    // The same question across every subject, used for a meter-wide total.
    { on: ["meter", "occurred_at"] },
  ]);

export default UsageEvent;
