/**
 * Container registration key for the usage module.
 *
 * In its own file, with no imports, because both the module definition and the
 * sink providers that register against it need it - and if it lived in the
 * module's `index.ts`, a provider importing it would close a cycle through the
 * loader that imports the provider. Medusa core keeps its module keys in a
 * dependency-free constants file for the same reason.
 *
 * Resolve the module from anywhere that has the Medusa container:
 *
 *   const usage = req.scope.resolve(USAGE_MODULE) as UsageModuleService
 *   await usage.record({ meter: "api_request", subject: customerId, quantity: 1 })
 */
export const USAGE_MODULE = "usage";
