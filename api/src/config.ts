/**
 * Runtime configuration, resolved once at process start.
 *
 * Every default here is the *Docker Compose* value (service names, not
 * localhost) so that `docker compose up` needs no environment file at all.
 * Running the gateway on the host is the case that requires overrides — see
 * the environment-variable table in README.md.
 */
import { fileURLToPath } from "node:url";

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `environment variable ${name} must be a positive integer, got "${raw}"`,
    );
  }
  return parsed;
}

/** Strip any trailing slashes so we can concatenate paths without doubling up. */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

const otlpBase = trimSlash(str("OTEL_EXPORTER_OTLP_ENDPOINT", "http://jaeger:4318"));

export const config = {
  /** HTTP listen address for the Fastify gateway. */
  host: str("HOST", "0.0.0.0"),
  port: int("PORT", 3000),
  logLevel: str("LOG_LEVEL", "info"),

  /** Reported as `service.name` on every span this process emits. */
  serviceName: str("OTEL_SERVICE_NAME", "prediction-api"),
  serviceVersion: str("SERVICE_VERSION", "1.0.0"),
  environment: str("DEPLOYMENT_ENV", "local"),

  /** `host:port` of the Python inference sidecar's gRPC listener. */
  sidecarTarget: str("SIDECAR_GRPC_TARGET", "sidecar:50051"),

  /**
   * Full OTLP/HTTP traces URL. Defaults to the Compose-internal Jaeger
   * collector; `jaeger` resolves over the Compose network, so this must not be
   * hardcoded to localhost.
   */
  otlpTracesUrl: trimSlash(
    str("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", `${otlpBase}/v1/traces`),
  ),

  /** Jaeger *query* API root, used by /trace-test to read traces back. */
  jaegerQueryUrl: trimSlash(str("JAEGER_QUERY_URL", "http://jaeger:16686")),

  /** Deadline applied to the unary Predict RPC. */
  grpcDeadlineMs: int("GRPC_DEADLINE_MS", 15_000),
  /** Deadline applied to the whole StreamPredictions RPC. */
  grpcStreamDeadlineMs: int("GRPC_STREAM_DEADLINE_MS", 120_000),

  /** How long /trace-test polls the Jaeger query API before giving up. */
  traceTestTimeoutMs: int("TRACE_TEST_TIMEOUT_MS", 20_000),
  traceTestPollIntervalMs: int("TRACE_TEST_POLL_INTERVAL_MS", 500),

  /**
   * Descriptor loaded at runtime by @grpc/proto-loader. Defaults to the
   * build output at <repo>/shared/node/prediction.proto, resolved relative to
   * this module so it works from both `src/` (tsx) and `dist/` (compiled).
   */
  protoPath:
    process.env.PROTO_PATH && process.env.PROTO_PATH !== ""
      ? process.env.PROTO_PATH
      : fileURLToPath(new URL("../../shared/node/prediction.proto", import.meta.url)),
} as const;

export type Config = typeof config;
