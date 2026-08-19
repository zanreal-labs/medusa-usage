import Medusa from "@medusajs/js-sdk";

/**
 * Admin API client for the usage screen.
 *
 * `auth.type: "session"` is what the Medusa Admin dashboard itself uses, so every
 * request below reuses the session cookie the dashboard already holds. The screen
 * never handles a token, and there is deliberately no second credential for it to
 * store - the routes it calls are the same authenticated `/admin` routes a machine
 * producer reaches with an API key.
 *
 * `VITE_BACKEND_URL` lets a store whose admin is served from a different origin
 * than its backend point at it; it defaults to the same origin.
 */
export const sdk = new Medusa({
  auth: { type: "session" },
  baseUrl: import.meta.env.VITE_BACKEND_URL || "/",
  debug: import.meta.env.DEV,
});
