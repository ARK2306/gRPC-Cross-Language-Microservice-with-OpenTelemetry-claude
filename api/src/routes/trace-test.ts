/**
 * GET /trace-test — end-to-end verification of the tracing pipeline.
 *
 * Rather than asserting that the exporter was *configured*, this route proves
 * the whole path works:
 *
 *   1. open a span and make a real unary call to the Python sidecar, so the
 *      trace contains spans from both services (proving W3C context
 *      propagation over gRPC metadata);
 *   2. force-flush the gateway's BatchSpanProcessor to the OTLP/HTTP collector;
 *   3. poll the Jaeger *query* API until that trace id comes back, and report
 *      which services contributed spans.
 *
 * A 503 from this route means traces are not reaching Jaeger, and the payload
 * carries the exporter/query URLs actually in use for debugging.
 */
import { SpanStatusCode } from "@opentelemetry/api";
import type { FastifyInstance } from "fastify";

import { config } from "../config.js";
import { GrpcCallError, predict } from "../grpc-client.js";
import { waitForTrace } from "../jaeger.js";
import { flushTraces, tracer } from "../tracing.js";

export async function registerTraceTestRoute(app: FastifyInstance): Promise<void> {
  app.get("/trace-test", async (request, reply) => {
    const startedAt = Date.now();

    const outcome = await tracer.startActiveSpan("trace-test.verify", async (span) => {
      span.setAttribute("trace_test.sidecar_target", config.sidecarTarget);
      try {
        // A real cross-service RPC — this is what puts sidecar spans in the trace.
        const prediction = await predict({
          input: [1, 2, 3],
          model: "trace-test",
          request_id: `trace-test-${request.id}`,
        });
        span.setAttributes({
          "trace_test.sidecar_ok": true,
          "prediction.cached": prediction.cached,
          "prediction.compute_ms": prediction.compute_ms,
        });
        return { ok: true as const, prediction, traceId: span.spanContext().traceId };
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        return {
          ok: false as const,
          error: err,
          traceId: span.spanContext().traceId,
        };
      } finally {
        span.end();
      }
    });

    const traceId = outcome.traceId;

    if (!outcome.ok) {
      const err = outcome.error;
      request.log.error({ err }, "trace-test sidecar call failed");
      return reply.status(502).send({
        verified: false,
        stage: "sidecar_call",
        trace_id: traceId,
        message:
          err instanceof GrpcCallError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
        sidecar_target: config.sidecarTarget,
      });
    }

    // Without this the span is still queued in the batch processor and the
    // Jaeger lookup below races the export tick.
    await flushTraces();

    // Wait for spans from *both* services, not merely for the trace to exist:
    // the gateway's own spans are flushed above, so a trace containing only
    // them proves nothing about context propagation. The sidecar's batch
    // processor adds its spans a few hundred milliseconds later.
    const { trace, attempts, elapsedMs } = await waitForTrace(traceId, {
      timeoutMs: config.traceTestTimeoutMs,
      intervalMs: config.traceTestPollIntervalMs,
      until: (candidate) =>
        candidate.services.includes(config.serviceName) && candidate.services.length > 1,
    });

    const body = {
      verified: trace !== null,
      trace_id: traceId,
      jaeger_ui_url: `${config.jaegerQueryUrl}/trace/${traceId}`,
      exporter: {
        otlp_traces_endpoint: config.otlpTracesUrl,
        jaeger_query_url: config.jaegerQueryUrl,
      },
      lookup: {
        attempts,
        elapsed_ms: elapsedMs,
        timeout_ms: config.traceTestTimeoutMs,
      },
      total_ms: Date.now() - startedAt,
      ...(trace
        ? {
            span_count: trace.spans.length,
            services: trace.services,
            // Both services present is the real assertion: it proves the
            // traceparent survived the gRPC hop.
            cross_service:
              trace.services.includes(config.serviceName) && trace.services.length > 1,
            operations: trace.spans.map((s) => `${s.serviceName}:${s.operationName}`),
          }
        : {
            message:
              "trace was exported but did not appear in the Jaeger query API within the timeout",
          }),
    };

    return reply.status(trace ? 200 : 503).send(body);
  });
}
