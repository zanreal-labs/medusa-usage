import { MedusaError } from "@medusajs/framework/utils";

/**
 * The minimum of knex this package uses, and the one place it is typed.
 *
 * Typed structurally rather than imported: knex is a transitive dependency of
 * MikroORM here, not a declared one, and declaring it would make this package
 * depend on a version it does not choose.
 *
 * Two things reach for raw SQL, for the reasons written where they do it - the
 * built-in Postgres sink, and the billing period store. Both need the same three
 * pieces of plumbing, so the plumbing lives here rather than being written twice
 * and drifting.
 */

export interface RawSqlRunner {
  raw: <TRow>(
    sql: string,
    bindings: readonly unknown[],
  ) => Promise<{ rows?: TRow[] } | TRow[] | undefined>;
}

export interface ManagerLike {
  getKnex?: () => RawSqlRunner;
  getConnection?: () => { getKnex?: () => RawSqlRunner };
}

/** knex's `raw` resolves to the driver's result (`{ rows }` on pg), typed loosely. */
export const rowsOf = <TRow>(result: { rows?: TRow[] } | TRow[] | undefined): TRow[] => {
  if (Array.isArray(result)) {
    return result;
  }
  return result?.rows ?? [];
};

/**
 * The module's own database connection, out of whatever holds it.
 *
 * Resolved on use rather than at construction: providers and stores are built
 * alongside the connection, and reaching for it early would make them depend on
 * the order two loaders happen to run in.
 */
export const knexFor = (manager: ManagerLike | undefined, what: string): RawSqlRunner => {
  const knex = manager?.getKnex?.() ?? manager?.getConnection?.()?.getKnex?.();
  if (!knex) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `medusa-usage: ${what} has no database connection. It reads the module's own connection from the container, so this means the module was constructed without one.`,
    );
  }
  return knex;
};

/** A `timestamptz` or a `text` column carrying one, as a Date. */
export const dateOrNull = (value: Date | string | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value);
