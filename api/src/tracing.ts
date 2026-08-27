/**
 * OpenTelemetry bootstrap for the gateway.
 *
 * MUST be imported before fastify/@grpc/grpc-js so the instrumentations can
 * patch those modules — see the import order at the top of src/server.ts.
 *
 * Spans are exported over OTLP/HTTP to the Jaeger collector
 * (http://jaeger:4318/v1/traces by default). The gRPC instrumentation injects
 * W3C traceparent metadata on outgoing calls, which the Python sidecar's
 * server interceptor extracts, so one HTTP request produces a single trace
 * spanning both services.
 */
import { diag, DiagConsoleLogger, DiagLogLevel, trace, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify";
import { GrpcInstrumentation } from "@opentelemetry/instrumentation-grpc";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { Resource } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import { config } from "./config.js";

if (process.env.OTEL_DIAG_LOG_LEVEL) {
  const level =
    DiagLogLevel[process.env.OTEL_DIAG_LOG_LEVEL.toUpperCase() as keyof typeof DiagLogLevel];
  diag.setLogger(new DiagConsoleLogger(), level ?? DiagLogLevel.INFO);
}

const exporter = new OTLPTraceExporter({
  url: config.otlpTracesUrl,
  // Keep a failed collector from stalling request handling.
  timeoutMillis: 10_000,
  concurrencyLimit: 10,
});

/**
 * Short batch delay: /trace-test force-flushes anyway, but a small window keeps
 * ordinary traffic visible in the Jaeger UI within a second or so.
 */
const spanProcessor = new BatchSpanProcessor(exporter, {
  scheduledDelayMillis: 500,
  maxExportBatchSize: 512,
  maxQueueSize: 2048,
  exportTimeoutMillis: 10_000,
});

const provider = new NodeTracerProvider({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    "deployment.environment.name": config.environment,
  }),
  spanProcessors: [spanProcessor],
});

provider.register();

registerInstrumentations({
  tracerProvider: provider,
  instrumentations: [
    new HttpInstrumentation({
      // The readiness probe and Jaeger query polling would otherwise bury the
      // real traces under health-check noise.
      ignoreIncomingRequestHook: (req) => {
        const url = req.url ?? "";
        return url.startsWith("/healthz") || url.startsWith("/readyz");
      },
      ignoreOutgoingRequestHook: (options) => {
        const path = typeof options.path === "string" ? options.path : "";
        return path.startsWith("/api/traces") || path.startsWith("/api/services");
      },
    }),
    new FastifyInstrumentation(),
    new GrpcInstrumentation(),
  ],
});

/** Tracer for the gateway's own manual spans. */
export const tracer: Tracer = trace.getTracer(config.serviceName, config.serviceVersion);

/**
 * Push everything currently queued to the collector.
 *
 * /trace-test calls this before querying Jaeger: without it the span for the
 * request being verified would still be sitting in the batch processor and the
 * lookup would race the 500 ms export tick.
 */
export async function flushTraces(): Promise<void> {
  await provider.forceFlush();
}

/** Flush and tear down the exporter during graceful shutdown. */
export async function shutdownTracing(): Promise<void> {
  await provider.shutdown();
}
