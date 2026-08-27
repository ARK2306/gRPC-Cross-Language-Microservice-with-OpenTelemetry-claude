/**
 * Fastify plugin exposing the active OpenTelemetry span on the request.
 *
 * Handlers use `request.traceId` to echo a correlation id back to the caller
 * and to stamp it on log lines, and `request.otelSpan` to attach
 * business-level attributes to the span the HTTP instrumentation already
 * created.
 */
import { trace, type Span } from "@opentelemetry/api";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyRequest {
    /** Active server span, or undefined if the request is not being traced. */
    otelSpan?: Span;
    /** 32-char hex trace id of the active span, or undefined. */
    traceId?: string;
  }
}

const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest("otelSpan", undefined);
  app.decorateRequest("traceId", undefined);

  app.addHook("onRequest", async (request) => {
    const span = trace.getActiveSpan();
    if (!span) return;
    const context = span.spanContext();
    request.otelSpan = span;
    request.traceId = context.traceId;

    span.setAttribute("http.request_id", request.id);
  });

  // Surface the trace id on every response so a caller can look the request up
  // in Jaeger without needing /trace-test.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.traceId) reply.header("x-trace-id", request.traceId);
    return payload;
  });
};

export const traceContextPlugin = fp(plugin, { name: "trace-context" });
