/**
 * Shared helpers for the integration suite.
 *
 * The suite runs against a *live* stack (docker compose locally, `docker run`
 * containers in CI) and talks to it exactly the way a real client would: HTTP
 * to the gateway, gRPC to the sidecar, and the Jaeger query API to verify
 * traces actually landed.
 */
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

export const API_BASE_URL = (process.env.API_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
export const JAEGER_QUERY_URL = (process.env.JAEGER_QUERY_URL ?? "http://localhost:16686").replace(/\/+$/, "");
export const SIDECAR_TARGET = process.env.SIDECAR_GRPC_TARGET ?? "localhost:50051";

/** Descriptor produced by `pnpm run proto:node`. */
export const PROTO_PATH =
  process.env.PROTO_PATH ??
  fileURLToPath(new URL("../../shared/node/prediction.proto", import.meta.url));

/** Unique per run, so cache assertions aren't contaminated by earlier runs. */
export function uniqueInput(size = 3) {
  const salt = Date.now() + Math.random();
  return Array.from({ length: size }, (_, i) => Number(((salt % 1000) + i).toFixed(4)));
}

// ----------------------------------------------------------------- HTTP

export async function apiFetch(path, init = {}) {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) },
  });
}

export async function postPredict(body) {
  const res = await apiFetch("/predict", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: await res.json() };
}

/**
 * Block until the gateway reports healthy.
 *
 * The stack takes a while to come up (image start + sidecar warm-up), and
 * failing the first test on a race would be noise rather than signal.
 */
export async function waitForApi({ timeoutMs = 120_000, intervalMs = 1_000 } = {}) {
  const giveUpAt = Date.now() + timeoutMs;
  let lastError = "no attempt made";

  while (Date.now() < giveUpAt) {
    try {
      const res = await fetch(`${API_BASE_URL}/healthz`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await delay(intervalMs);
  }
  throw new Error(`gateway at ${API_BASE_URL} never became healthy: ${lastError}`);
}

// ------------------------------------------------------------------ SSE

/**
 * Consume an SSE response into a list of {event, data, id} frames.
 *
 * Deliberately hand-rolled rather than using an EventSource polyfill: the test
 * should assert on the exact bytes the gateway puts on the wire, including the
 * terminal `end` event.
 */
export async function readSse(response, { maxEvents = 1000 } = {}) {
  if (!response.body) throw new Error("SSE response had no body");

  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      // `:` prefixed lines are comments (we send one to flush headers).
      const lines = raw.split("\n").filter((l) => l && !l.startsWith(":"));
      if (lines.length === 0) continue;

      const frame = { event: "message", data: undefined, id: undefined };
      for (const line of lines) {
        const sep = line.indexOf(":");
        const field = sep === -1 ? line : line.slice(0, sep);
        const value = sep === -1 ? "" : line.slice(sep + 1).trimStart();
        if (field === "event") frame.event = value;
        else if (field === "data") frame.data = JSON.parse(value);
        else if (field === "id") frame.id = value;
      }
      events.push(frame);
      if (events.length >= maxEvents) return events;
    }
  }
  return events;
}

// ----------------------------------------------------------------- gRPC

let cachedClient;

/** Direct gRPC client to the sidecar, bypassing the gateway entirely. */
export function sidecarClient() {
  if (cachedClient) return cachedClient;

  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition);
  cachedClient = new proto.prediction.v1.PredictionService(
    SIDECAR_TARGET,
    grpc.credentials.createInsecure(),
  );
  return cachedClient;
}

export function closeSidecarClient() {
  if (cachedClient) {
    cachedClient.close();
    cachedClient = undefined;
  }
}

export function grpcPredict(request, deadlineMs = 30_000) {
  return new Promise((resolve, reject) => {
    sidecarClient().Predict(
      request,
      { deadline: new Date(Date.now() + deadlineMs) },
      (err, response) => (err ? reject(err) : resolve(response)),
    );
  });
}

/** Collect every delta from the server-streaming RPC. */
export function grpcStream(request, deadlineMs = 60_000) {
  return new Promise((resolve, reject) => {
    const call = sidecarClient().StreamPredictions(request, {
      deadline: new Date(Date.now() + deadlineMs),
    });
    const deltas = [];
    call.on("data", (delta) => deltas.push(delta));
    call.on("error", reject);
    call.on("end", () => resolve(deltas));
  });
}

// --------------------------------------------------------------- Jaeger

export async function fetchJaegerTrace(traceId) {
  const res = await fetch(`${JAEGER_QUERY_URL}/api/traces/${encodeURIComponent(traceId)}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`jaeger query returned ${res.status}`);
  const body = await res.json();
  const trace = body?.data?.[0];
  if (!trace) return null;

  const processes = trace.processes ?? {};
  const spans = (trace.spans ?? []).map((s) => ({
    operationName: s.operationName,
    serviceName: processes[s.processID]?.serviceName ?? "unknown",
  }));
  return { traceID: trace.traceID, spans, services: [...new Set(spans.map((s) => s.serviceName))].sort() };
}

/**
 * Poll Jaeger until `until` holds for the trace, or the budget runs out.
 *
 * A trace is assembled from spans exported independently by each service, so
 * "the trace exists" and "the trace is complete" are different questions.
 * Tests that assert on a specific span must wait for *that span*, otherwise
 * they race whichever batch happened to arrive first.
 *
 * Returns the last version of the trace seen even on timeout, so failures can
 * report what actually arrived.
 */
export async function waitForJaegerTrace(
  traceId,
  { timeoutMs = 30_000, intervalMs = 750, until = (trace) => trace.spans.length > 0 } = {},
) {
  const giveUpAt = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < giveUpAt) {
    try {
      const trace = await fetchJaegerTrace(traceId);
      if (trace && trace.spans.length > 0) {
        lastSeen = trace;
        if (until(trace)) return trace;
      }
    } catch {
      // Jaeger indexes asynchronously; keep trying until the budget runs out.
    }
    await delay(intervalMs);
  }
  return lastSeen;
}

export async function jaegerServices() {
  const res = await fetch(`${JAEGER_QUERY_URL}/api/services`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`jaeger /api/services returned ${res.status}`);
  const body = await res.json();
  return body?.data ?? [];
}
