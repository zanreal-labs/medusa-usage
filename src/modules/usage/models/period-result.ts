import { model } from "@medusajs/framework/utils";

/**
 * The frozen result of a closed period. The row an invoice is built from.
 *
 * ## Closing is an insert, and that is what makes it idempotent
 *
 * `id` is the period's id, so a period has at most one result and the primary key
 * is what enforces it. Closing a period is `insert ... on conflict do nothing`:
 * the first call appends a row and reports that it closed the period, and every
 * call after it appends nothing and reports the stored result instead. Two
 * processes racing to close the same period produce one row, and both of them
 * return the same answer - the winner's.
 *
 * There is no check-then-write anywhere in that path, deliberately. A read
 * followed by a write has a window between them, and a window is all a retried
 * job needs to bill a customer twice.
 *
 * ## Nothing here is ever updated
 *
 * A result is written once. There is no status, no "corrected" flag and no
 * recomputation in place, because the number on an invoice must not move after the
 * invoice exists. If the log gains events in a closed window afterwards, the
 * result stays exactly as it was billed and the difference is carried into an open
 * period as usage, which is how a ledger handles it. `verifyPeriod` is the read
 * that detects the drift; there is no write that resolves it.
 *
 * ## Why the same facts are both columns and JSON
 *
 * `result` is the whole `PeriodResult`, verbatim, and is the authoritative copy: a
 * host stores or serves it unchanged and the digest is over it. The columns beside
 * it exist so the obvious operational questions - which periods for this subject,
 * what did this month come to, what is closed - are one indexed query rather than
 * a scan that parses JSON.
 */
const PeriodResult = model
  .define("usage_period_result", {
    /** Inclusive lower bound of the window this rates. */
    starts_at: model.dateTime(),
    /** The period's id. One period, at most one result, enforced by this key. */
    id: model.text().primaryKey(),
    /** The digest over the result. Compared against a re-derivation months later. */
    digest: model.text(),
    /** When the period was closed. Its presence is what "closed" means. */
    closed_at: model.dateTime(),
    /** ISO 4217, carried through from the rate card. Never interpreted here. */
    currency: model.text(),
    /** Exclusive upper bound of the window this rates. */
    ends_at: model.dateTime(),
    /** The whole `PeriodResult`, verbatim. The authoritative copy. */
    result: model.json(),
    /** Who the period belongs to. */
    subject: model.text(),
    /**
     * The rated total in minor currency units, lifted out of `result` so it can be
     * summed and filtered in the database.
     *
     * A `bigNumber` for the same reason `usage_event.quantity` is one: numeric
     * arithmetic in Postgres is exact at any size, and money is the last place to
     * accept a rounded sum. It may be negative, which is a period whose
     * corrections outweighed its usage.
     */
    total_amount: model.bigNumber(),
  })
  .indexes([
    // Every closed period for one subject, newest first.
    { on: ["subject", "starts_at"] },
    // Everything closed in some interval, across subjects: the billing run.
    { on: ["closed_at"] },
  ]);

export default PeriodResult;
