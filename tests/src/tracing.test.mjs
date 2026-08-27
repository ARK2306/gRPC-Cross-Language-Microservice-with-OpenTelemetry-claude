/**
 * Trace export verification.
 *
 * The assertion that matters is not "the exporter is configured" but "a trace
 * produced by a real request is retrievable from Jaeger, and it contains spans
 * from *both* services" — which is only true if the W3C traceparent survives
 * the gRPC hop from the Node gateway to the Python sidecar.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
  apiFetch,
  jaegerServices,
  postPredict,
  uniqueInput,
  waitForApi,
  waitForJaegerTrace,
} from "./helpers.mjs";

const API_SERVICE = process.env.OTEL_SERVICE_NAME ?? "prediction-api";
const SIDECAR_SERVICE = process.env.SIDECAR_SERVICE_NAME ?? "prediction-sidecar";

describe("OpenTelemetry trace export", { timeout: 240_000 }, () => {
  before(async () => {
    await waitForApi();
  });

  it("GET /trace-test returns a trace id that is queryable in Jaeger", async () => {
    const res = await apiFetch("/trace-test");
    const body = await res.json();

    assert.equal(
      res.status,
      200,
      `/trace-test did not verify the pipeline: ${JSON.stringify(body, null, 2)}`,
    );
    assert.equal(body.verified, true);
    assert.match(body.trace_id, /^[0-9a-f]{32}$/, "trace_id must be a 32-char hex id");
    assert.ok(body.span_count > 0, "the trace must contain at least one span");

    // The route reports the endpoints it actually used; assert it is talking to
    // the collector over OTLP/HTTP rather than falling back to a default.
    assert.match(body.exporter.otlp_traces_endpoint, /\/v1\/traces$/);

    // Independently re-query Jaeger, so the test does not simply trust the
    // service's own report.
    const trace = await waitForJaegerTrace(body.trace_id);
    assert.ok(trace, `trace ${body.trace_id} was not retrievable from the Jaeger query API`);
    assert.equal(trace.traceID, body.trace_id);
    assert.ok(trace.spans.length > 0);
  });

  it("propagates trace context across the gRPC hop into the sidecar", async () => {
    const res = await apiFetch("/trace-test");
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));

    const trace = await waitForJaegerTrace(body.trace_id, {
      until: (t) => t.services.includes(API_SERVICE) && t.services.includes(SIDECAR_SERVICE),
    });
    assert.ok(trace, `trace ${body.trace_id} not found in Jaeger`);

    assert.ok(
      trace.services.includes(API_SERVICE),
      `expected gateway spans from "${API_SERVICE}"; got ${JSON.stringify(trace.services)}`,
    );
    assert.ok(
      trace.services.includes(SIDECAR_SERVICE),
      `expected sidecar spans from "${SIDECAR_SERVICE}" in the same trace — ` +
        `context propagation over gRPC metadata is broken. got ${JSON.stringify(trace.services)}`,
    );
  });

  it("traces an ordinary /predict request through both services", async () => {
    const { res, body } = await postPredict({ input: uniqueInput() });
    assert.equal(res.status, 200);

    const traceId = res.headers.get("x-trace-id");
    assert.match(traceId ?? "", /^[0-9a-f]{32}$/);
    assert.equal(traceId, body.trace_id);

    // Wait for the gRPC span specifically: the gateway's HTTP span, the gRPC
    // client span and the sidecar's spans are exported by three independent
    // batch processors and arrive out of order.
    const trace = await waitForJaegerTrace(traceId, {
      until: (t) =>
        t.services.includes(SIDECAR_SERVICE) && t.spans.some((s) => /predict/i.test(s.operationName)),
    });
    assert.ok(trace, `trace ${traceId} for POST /predict never reached Jaeger`);
    assert.ok(
      trace.services.includes(SIDECAR_SERVICE),
      `POST /predict trace is missing sidecar spans: ${JSON.stringify(trace.services)}`,
    );
    assert.ok(
      trace.spans.some((s) => /predict/i.test(s.operationName)),
      `expected a Predict span; got ${JSON.stringify(trace.spans.map((s) => s.operationName))}`,
    );
  });

  it("registers both services with Jaeger", async () => {
    const services = await jaegerServices();
    for (const expected of [API_SERVICE, SIDECAR_SERVICE]) {
      assert.ok(
        services.includes(expected),
        `Jaeger has not seen "${expected}"; known services: ${JSON.stringify(services)}`,
      );
    }
  });
});
