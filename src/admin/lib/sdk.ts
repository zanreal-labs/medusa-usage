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
 * The base URL is the origin the admin is served from, and there is no option to
 * change it. A plugin's admin extensions are built here, into a bundle a host then
 * includes, so any `import.meta.env` value would be frozen at THIS package's build
 * rather than read from the host's - an override a consumer could never actually
 * set. Serving the admin from a different origin than the backend is a deployment
 * this screen does not support, and saying so is better than offering a switch
 * that does nothing.
 */
export const sdk = new Medusa({
  auth: { type: "session" },
  baseUrl: "/",
});
