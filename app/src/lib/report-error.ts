/**
 * Single seam for sending unexpected errors to an external error-tracking service. Every call
 * site (the root route's `errorComponent`, the mutation cache's `onError`, ...) calls
 * `reportError` rather than `console.error` or a vendor SDK directly, so wiring up Sentry (or
 * swapping it for something else later) is a one-line change here instead of a grep-and-replace
 * across the app. The default sink is a no-op — nothing is reported anywhere until
 * `setErrorReportSink` is called, which `main.tsx` would do once, at startup, behind whatever
 * env var gates the vendor's DSN.
 */

export type ErrorReportContext = Record<string, unknown>;

export type ErrorReportSink = (error: unknown, context?: ErrorReportContext) => void;

let sink: ErrorReportSink = () => {};

/** Swaps in a real sink (e.g. `Sentry.captureException`). Call once, at startup. */
export function setErrorReportSink(nextSink: ErrorReportSink): void {
  sink = nextSink;
}

/** Reports an error through the currently configured sink. Never throws. */
export function reportError(error: unknown, context?: ErrorReportContext): void {
  sink(error, context);
}
