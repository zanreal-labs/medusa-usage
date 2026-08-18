import { defineMiddlewares } from "@medusajs/framework/http";

/**
 * Route middleware for the usage plugin.
 *
 * Nothing is registered, and that is the point of the file existing: it is the
 * documented place someone would reach for `AUTHENTICATE: false` to let a metered
 * service post its own usage without a session, and the reason not to belongs
 * here where they will look.
 *
 * Every route this plugin adds lives under `/admin`, which Medusa authenticates
 * by default, and that default is load-bearing:
 *
 * - `POST /admin/usage/events` writes to the log that whatever is billed will be
 *   computed from. An unauthenticated version of it is a way for anyone to
 *   inflate, or dilute, someone's bill.
 * - `GET /admin/usage/events` and `GET /admin/usage/aggregate` read one subject's
 *   consumption. The subject is an opaque host identifier, but the consumption is
 *   still that customer's business and nobody else's.
 *
 * A machine producer is a first-class caller here and does not need this
 * relaxed: Medusa authenticates admin routes with an API key as well as with a
 * session, so a metered service gets its own key, which can be rotated and
 * revoked. A shared secret in a middleware cannot.
 *
 * If a public ingestion endpoint is ever genuinely needed - a browser reporting
 * its own usage, say - it belongs on `/store` behind a publishable key, with the
 * subject derived from the authenticated customer rather than taken from the
 * body, and never as a relaxation of these.
 */
export default defineMiddlewares({
  routes: [],
});
