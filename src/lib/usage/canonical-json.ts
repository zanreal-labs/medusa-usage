/**
 * Canonical JSON: one byte sequence per value, forever.
 *
 * The deduplication key (see `./dedupe.ts`) and the snapshot digest (see
 * `./snapshot.ts`) are both hashes of text produced here, so this function is the
 * thing that decides whether the same event, sent twice, hashes to the same key.
 * `JSON.stringify` cannot be used for that: it preserves insertion order, so
 * `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` - the same value by every definition a
 * caller cares about - would produce two different keys and therefore two counts
 * of one event.
 *
 * The rules, all of them deliberate:
 *
 * - Object keys are sorted by UTF-16 code unit, recursively. This is `Object.keys`
 *   order removed from the equation entirely.
 * - Arrays keep their order. An array is a sequence, and reordering one changes
 *   what it means.
 * - Only JSON's own value space is accepted: string, finite number, boolean, null,
 *   array, plain object. `undefined`, functions, symbols, bigints and non-finite
 *   numbers throw rather than being dropped or coerced, because every one of those
 *   would otherwise turn into a silent difference between what the caller sent and
 *   what was hashed.
 * - `Date`, `Map`, `Set` and class instances throw for the same reason. A caller
 *   who wants a timestamp in a property bag must decide its string form itself,
 *   rather than inheriting whatever `toJSON` happens to do today.
 * - Cycles throw.
 *
 * Numbers are serialized with JavaScript's own shortest round-trip representation
 * (`String(n)`), which is stable across engines and versions for every finite
 * double. Note that `1` and `1.0` are the same double and therefore the same text:
 * JSON has one number type and this follows it.
 */

/** The value space this module accepts. Anything else is a programming error. */
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

/** Thrown for any value that has no canonical JSON form. */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
};

const describe = (value: unknown): string => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    return (value as object).constructor?.name ?? "object";
  }
  return typeof value;
};

const write = (value: unknown, path: string, seen: Set<object>): string => {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean": {
      return value ? "true" : "false";
    }
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(
          `${path}: ${String(value)} has no JSON representation. Usage properties must be finite numbers.`,
        );
      }
      return String(value);
    }
    case "string": {
      return JSON.stringify(value);
    }
    default: {
      break;
    }
  }

  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value as object)) {
      throw new CanonicalJsonError(`${path}: circular reference.`);
    }
    seen.add(value as object);
    const text = Array.isArray(value)
      ? `[${value.map((entry, index) => write(entry, `${path}[${index}]`, seen)).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${write((value as Record<string, unknown>)[key], `${path}.${key}`, seen)}`,
          )
          .join(",")}}`;
    seen.delete(value as object);
    return text;
  }

  throw new CanonicalJsonError(
    `${path}: ${describe(value)} has no JSON representation. Usage properties must be strings, finite numbers, booleans, null, arrays or plain objects.`,
  );
};

/**
 * The canonical text for a value. Deterministic across processes, machines and
 * Node versions - the input to every hash this plugin takes.
 */
export function canonicalJson(value: JsonValue): string {
  return write(value, "$", new Set<object>());
}

/**
 * `true` when `value` is inside the accepted value space. Used at the validation
 * boundary so a bad property bag is rejected with a field-level message rather
 * than surfacing later as a hashing failure.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  try {
    canonicalJson(value as JsonValue);
    return true;
  } catch {
    return false;
  }
}
