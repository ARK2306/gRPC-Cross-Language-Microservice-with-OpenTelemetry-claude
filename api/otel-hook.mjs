/**
 * Registers OpenTelemetry's ESM module hook.
 *
 * Loaded via `node --import ./otel-hook.mjs` so it runs before any application
 * module is resolved.
 *
 * Why this file exists: OpenTelemetry's auto-instrumentation patches modules by
 * intercepting `require()`. That covers CommonJS dependencies (Fastify's
 * internal `require('http')`, for example) but *not* modules this codebase
 * imports with ESM `import` — notably `@grpc/grpc-js`. Without this hook the
 * gRPC client spans are silently missing, no traceparent is injected into call
 * metadata, and the sidecar starts a brand-new trace instead of joining ours.
 *
 * See the "Tracing" section of README.md.
 */
import { register } from "node:module";

register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
