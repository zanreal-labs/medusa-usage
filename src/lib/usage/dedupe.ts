import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import type { UsageEventFacts } from "./event";

/**
 * Deduplication.
 *
 * Usage that double-counts is worse than usage that is missing: a missing event
 * is a number that is too small and visibly so, while a duplicated event silently
 * inflates whatever is priced off it, and nobody finds out until a customer
 * disputes a bill. So the ingestion path is built to be replay-safe from end to
 * end, and this file is where that property comes from.
 *
 * ## The rule
 *
 * A usage event's key is a pure function of what the event MEANS. Nothing
 * ambient is allowed in: no random bytes, no `Date.now()`, no process id, no
 * hostname, no counter, no arrival order, no database sequence. Two calls
 * carrying the same facts produce the same key on any machine, in any process, in
 * any year - and the sink stores at most one row per key, forever.
 *
 * That is what makes the three replay paths harmless rather than expensive:
 *
 * - a retried HTTP call, because the client timed out on a request that had in
 *   fact succeeded;
 * - a redeploy or crash that replays a queue, a webhook, or an unacknowledged
 *   message;
 * - a backfill run twice by an operator who was not sure the first one finished.
 *
 * Each of them re-derives the identical key and the append is a no-op.
 *
 * ## The two forms
 *
 * **Explicit** - the caller passes `idempotencyKey`, because it already holds a
 * natural identity for the thing being metered (the request id, the upstream
 * event id, the primary key of the row being imported).
 *
 *     usg1 US explicit US meter US subject US key
 *
 * It is scoped to `(meter, subject)` rather than taken bare, and that scoping is
 * deliberate: a caller that meters two things about the same request ("tokens_in"
 * and "tokens_out" for request `req_9`) would otherwise have one of the two
 * silently swallow the other. Scoping to the grain aggregation runs at makes that
 * class of mistake impossible to make.
 *
 * **Derived** - no `idempotencyKey`, so identity comes from the full statement of
 * fact.
 *
 *     usg1 US derived US meter US subject US occurredAt US quantity US source US properties
 *
 * Every field that distinguishes one event from another is in there, and nothing
 * else is. `occurredAt` is the ISO 8601 instant at millisecond precision in UTC
 * (`2026-08-18T09:15:00.000Z`), so an event's key does not depend on the server's
 * time zone or on sub-millisecond noise. `quantity` is a decimal integer.
 * `properties` is canonical JSON (see `./canonical-json.ts`), so key order in the
 * object cannot change the key.
 *
 * ## What the derived form costs
 *
 * Two events that are genuinely distinct but identical in every recorded field,
 * including the millisecond, collapse into one. That is a real undercount, and it
 * is the deliberate trade: this scheme errs toward counting less rather than
 * counting twice. A caller who can produce such events - several units of the
 * same meter for the same subject in the same millisecond - must either pass an
 * `idempotencyKey`, or make the events distinguishable (an ordinal in
 * `properties`), or aggregate them into one event with a larger `quantity`, which
 * is usually what was meant anyway.
 *
 * ## Why the fields are joined with a unit separator
 *
 * `meter`, `subject`, `source` and the explicit key are all validated to contain
 * no control characters (see `./event.ts`), so U+001F cannot occur inside any of
 * them. The joined string is therefore an injective encoding of its parts: no two
 * different field tuples can produce the same text, which would otherwise be a
 * way to make two different events share a key.
 *
 * ## Versioning
 *
 * The `usg1` prefix inside the hashed text pins this derivation. If the rules
 * ever change, the prefix changes with them, and the two schemes cannot collide.
 * Old rows keep the keys they were written with; nothing is rehashed, because
 * rehashing a log is the same as rewriting it.
 */

/** Field separator. Cannot occur inside any field, so the join is injective. */
const SEPARATOR = "\u001F";

/** Pins this derivation. Changing any rule below means changing this. */
export const DEDUPE_SCHEME = "usg1";

/** Prefix on every key, so a usage key is recognisable in a log or a database. */
export const DEDUPE_KEY_PREFIX = "uev_";

/** `uev_` plus 64 hex characters of SHA-256. */
export const DEDUPE_KEY_LENGTH = DEDUPE_KEY_PREFIX.length + 64;

/**
 * The exact text that gets hashed. Exported for the tests that pin the
 * derivation, and for anyone who needs to reproduce a key outside this codebase.
 */
export function dedupeMaterialFor(facts: UsageEventFacts, explicitKey: string | null): string {
  if (explicitKey !== null) {
    return [DEDUPE_SCHEME, "explicit", facts.meter, facts.subject, explicitKey].join(SEPARATOR);
  }
  return [
    DEDUPE_SCHEME,
    "derived",
    facts.meter,
    facts.subject,
    facts.occurredAt.toISOString(),
    String(facts.quantity),
    facts.source ?? "",
    canonicalJson(facts.properties),
  ].join(SEPARATOR);
}

/**
 * The deduplication key for an event, which is also its identity in the log.
 *
 * Both forms are hashed, including the explicit one. That keeps every key the
 * same fixed width whatever the caller passes, and the `explicit`/`derived`
 * domain marker inside the hashed text means the two spaces cannot collide.
 */
export function dedupeKeyFor(facts: UsageEventFacts, explicitKey: string | null = null): string {
  const digest = createHash("sha256").update(dedupeMaterialFor(facts, explicitKey), "utf8");
  return `${DEDUPE_KEY_PREFIX}${digest.digest("hex")}`;
}
