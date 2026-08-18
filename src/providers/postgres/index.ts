import { ModuleProvider } from "@medusajs/framework/utils";
import PostgresUsageSinkService, { POSTGRES_USAGE_SINK } from "./service";
import { USAGE_MODULE } from "../../modules/usage/module-name";

/**
 * The built-in usage sink, registered against the usage module.
 *
 * It is the default: a host that configures no `providers` gets this one, under
 * the id "postgres". A host that configures its own list can still include it by
 * path, alongside or instead of another sink:
 *
 *   plugins: [
 *     {
 *       resolve: "@zanreal/medusa-usage",
 *       options: {
 *         providers: [
 *           { resolve: "@zanreal/medusa-usage/providers/postgres", id: "postgres" },
 *         ],
 *       },
 *     },
 *   ]
 */
export default ModuleProvider(USAGE_MODULE, {
  services: [PostgresUsageSinkService],
});

export { POSTGRES_USAGE_SINK, PostgresUsageSinkService };
