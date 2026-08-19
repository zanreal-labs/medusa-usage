import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One request, its error, and a way to ask again.
 *
 * The screen makes a handful of independent reads and each one has to be able to
 * fail on its own: a broken sink should not blank the periods list, and a period
 * that has never been closed should not blank the ingestion panel. So there is no
 * shared loading state and no shared error - every panel owns its own, and says
 * so where it is.
 *
 * The failure is surfaced as the API's own message rather than a status code. The
 * routes in this plugin explain themselves ("the period ... cannot be closed until
 * ...", "`from` is not an ISO 8601 instant"), the SDK puts that text on the thrown
 * error, and rewriting it here would only make it worse.
 */
export interface Request<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  /** Ask again. Used after a close, which changes what every other panel says. */
  reload: () => void;
}

/**
 * `run` is read through a ref so the effect depends on `deps` alone. The caller
 * lists what the request is actually a function of, which is what should decide
 * whether it is made again - an inline closure would re-fire on every render.
 *
 * `deps` must be a fixed-length literal at each call site. It is spread into a
 * dependency array, and React throws if that array changes size between renders.
 * A conditional dependency belongs in the value, not in the length: pass `null`
 * rather than omitting an entry.
 */
export function useRequest<T>(run: () => Promise<T>, deps: readonly unknown[]): Request<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; isLoading: boolean }>({
    data: null,
    error: null,
    isLoading: true,
  });
  const [nonce, setNonce] = useState(0);

  // Refreshed in an effect rather than during render. Effects run in declaration
  // order, so this one has already updated the ref by the time the request effect
  // below reads it, and render stays free of side effects.
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  });

  useEffect(() => {
    const request = latest.current;
    let cancelled = false;
    setState((previous) => ({ ...previous, error: null, isLoading: true }));

    request()
      .then((data) => {
        if (!cancelled) {
          setState({ data, error: null, isLoading: false });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ data: null, error: messageOf(error), isLoading: false });
        }
      });

    return () => {
      cancelled = true;
    };
    // The caller's `deps` are the request's real inputs; `nonce` is the manual
    // reload. `latest` is a ref and deliberately not a dependency.
  }, [...deps, nonce]);

  return {
    ...state,
    reload: useCallback(() => {
      setNonce((value) => value + 1);
    }, []),
  };
}

/** The API's own words where there are any. */
export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "The request failed, and said nothing about why.";
}
