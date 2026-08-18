import { MedusaError } from "@medusajs/framework/utils";
import type { UsageAggregateQuery, UsageListQuery } from "../sink/types";
import type { JsonScalar } from "./canonical-json";

/**
 * Turning a query string into a question about the log.
 *
 * Kept out of the route handlers so the parsing rules are one thing, tested once,
 * and identical between the aggregate endpoint and the listing endpoint - an
 * aggregate whose window is parsed differently from the listing that is supposed
 * to prove it would be worse than having no listing at all.
 *
 * Every failure names the parameter and says what shape it wanted. These are
 * operator-facing endpoints, and an operator reading "invalid query" learns
 * nothing.
 */

const invalid = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `medusa-usage: ${message}`);
};

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    return invalid(`\`${field}\` is required.`);
  }
  return value.trim();
};

const instant = (value: unknown, field: string): Date => {
  const text = requiredString(value, field);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return invalid(`\`${field}\` is not an ISO 8601 instant: ${text}`);
  }
  return parsed;
};

/**
 * `properties` arrives as JSON, and is restricted to a flat bag of scalars -
 * exactly the equality filter the sink contract promises, no more. Anything
 * nested would be a query language, and every sink would implement it slightly
 * differently.
 */
const dimensions = (value: unknown): Record<string, JsonScalar> | null => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return invalid("`properties` must be a JSON object of dimension equalities.");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid("`properties` must be a JSON object of dimension equalities.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [key, entry] of entries) {
    if (entry !== null && !["boolean", "number", "string"].includes(typeof entry)) {
      invalid(
        `\`properties.${key}\` must be a string, number, boolean or null. The filter is an equality on each dimension, not a query language.`,
      );
    }
  }
  return entries.length === 0 ? null : (parsed as Record<string, JsonScalar>);
};

/** `?meter=&subject=&from=&to=&properties=` into a sink query. */
export function parseAggregateQuery(query: Record<string, unknown>): UsageAggregateQuery {
  return {
    from: instant(query.from, "from"),
    meter: requiredString(query.meter, "meter"),
    properties: dimensions(query.properties),
    subject: typeof query.subject === "string" && query.subject.trim() ? query.subject.trim() : null,
    to: instant(query.to, "to"),
  };
}

/** The same, plus paging. */
export function parseListQuery(
  query: Record<string, unknown>,
  defaultLimit: number,
): UsageListQuery {
  const limit = query.limit === undefined || query.limit === "" ? defaultLimit : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    invalid(`\`limit\` must be a whole number of at least 1 (received ${String(query.limit)}).`);
  }
  return {
    ...parseAggregateQuery(query),
    cursor: typeof query.cursor === "string" && query.cursor ? query.cursor : null,
    limit,
  };
}
