/**
 * Minimal client for the Jaeger *query* API (port 16686).
 *
 * Only used by /trace-test, which needs to read a trace back out of Jaeger to
 * prove the OTLP export path actually works end to end.
 */
import { config } from "./config.js";

export interface JaegerSpanSummary {
  spanID: string;
  operationName: string;
  serviceName: string;
  durationUs: number;
}

export interface JaegerTrace {
  traceID: string;
  spans: JaegerSpanSummary[];
  services: string[];
}

interface RawJaegerResponse {
  data?: Array<{
    traceID: string;
    spans?: Array<{
      spanID: string;
      operationName: string;
      duration: number;
      processID: string;
    }>;
    processes?: Record<string, { serviceName: string }>;
  }>;
  errors?: Array<{ msg?: string }> | null;
}

/**
 * Fetch one trace by id.
 *
 * Returns `null` for "not indexed yet" (Jaeger answers 404 or an empty `data`
 * array), so callers can poll. Anything else throws.
 */
export async function fetchTrace(
  traceId: string,
  signal?: AbortSignal,
): Promise<JaegerTrace | null> {
  const url = `${config.jaegerQueryUrl}/api/traces/${encodeURIComponent(traceId)}`;
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`jaeger query API returned ${res.status} ${res.statusText} for ${url}`);
  }

  const body = (await res.json()) as RawJaegerResponse;
  const trace = body.data?.[0];
  if (!trace) return null;

  const processes = trace.processes ?? {};
  const spans = (trace.spans ?? []).map((span) => ({
    spanID: span.spanID,
    operationName: span.operationName,
    serviceName: processes[span.processID]?.serviceName ?? "unknown",
    durationUs: span.duration,
  }));

  return {
    traceID: trace.traceID,
    spans,
    services: [...new Set(spans.map((s) => s.serviceName))].sort(),
  };
}

/**
 * Poll until the trace shows up or the budget runs out.
 *
 * Jaeger indexes asynchronously, so a trace exported milliseconds ago is
 * routinely not queryable on the first attempt.
 */
export async function waitForTrace(
  traceId: string,
  {
    timeoutMs,
    intervalMs,
    until = (trace) => trace.spans.length > 0,
  }: {
    timeoutMs: number;
    intervalMs: number;
    /**
     * Keep polling until this holds. Defaults to "any span at all"; /trace-test
     * passes a stricter predicate so it does not report a half-arrived trace.
     */
    until?: (trace: JaegerTrace) => boolean;
  },
): Promise<{ trace: JaegerTrace | null; attempts: number; elapsedMs: number }> {
  const startedAt = Date.now();
  let attempts = 0;
  // Retained so a trace that arrives but never satisfies `until` is still
  // reported, rather than being indistinguishable from "nothing exported".
  let lastSeen: JaegerTrace | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    try {
      const trace = await fetchTrace(traceId);
      if (trace && trace.spans.length > 0) {
        lastSeen = trace;
        if (until(trace)) return { trace, attempts, elapsedMs: Date.now() - startedAt };
      }
    } catch {
      // Jaeger may still be starting up; keep polling until the budget is spent.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
  }

  return { trace: lastSeen, attempts, elapsedMs: Date.now() - startedAt };
}

/** Liveness probe for the Jaeger query service, used by /readyz. */
export async function jaegerReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${config.jaegerQueryUrl}/api/services`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
