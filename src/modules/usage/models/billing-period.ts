import { model } from "@medusajs/framework/utils";

/**
 * A billing period: one subject, one half-open window.
 *
 * ## Why this table is not in the sink
 *
 * The event log lives wherever the configured sink puts it, which may be a column
 * store on the other side of the internet. Periods do not. They live in the
 * Medusa database, always, whatever the sink is, because they are this module's
 * own state rather than usage: the sink contract is three methods over an
 * append-only log and it should stay that way. The split is deliberate and worth
 * knowing about when reading a deployment: events in Tinybird, periods and their
 * results in Postgres.
 *
 * ## The primary key is the period's identity
 *
 * `id` is not generated. It is a SHA-256 over the subject and the two instants
 * (see `src/lib/billing/period.ts`), so opening the same period twice cannot
 * produce two periods - the second insert conflicts and is ignored. The same
 * mechanism the usage log uses, in the same place: the primary key.
 *
 * As with `createUsageEvents`, the `createBillingPeriods` method that
 * `MedusaService` generates onto the service is not the path in. It would mint an
 * id of its own and defeat all of the above. The path in is
 * `UsageModuleService.openPeriod`.
 *
 * ## There is no status column
 *
 * Whether a period is closed is decided by one thing: whether a row exists in
 * `usage_period_result`. A status here could disagree with that row, and if it
 * ever did there would be no way to tell which of the two was the billing record.
 * So the period carries no mutable state at all, and this table is append-only
 * like every other in the plugin.
 */
const BillingPeriod = model
  .define("usage_billing_period", {
    /** Inclusive lower bound of the window. */
    starts_at: model.dateTime(),
    /** The derived period identity. See the note above. */
    id: model.text().primaryKey(),
    /** Exclusive upper bound of the window. */
    ends_at: model.dateTime(),
    /**
     * Who the period belongs to. The same opaque host identifier a usage event
     * carries as its subject, and never resolved against anything here.
     */
    subject: model.text(),
  })
  .indexes([
    // Every period for one subject, newest first: what a host lists to find the
    // one it has not billed yet.
    { on: ["subject", "starts_at"] },
    // Every period that ended before some instant, across subjects: what a
    // scheduled close sweeps.
    { on: ["ends_at"] },
  ]);

export default BillingPeriod;
