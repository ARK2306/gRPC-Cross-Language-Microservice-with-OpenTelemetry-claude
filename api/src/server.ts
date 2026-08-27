/**
 * Gateway entrypoint.
 *
 * `./tracing.js` must be imported before anything that pulls in fastify or
 * @grpc/grpc-js — the OpenTelemetry instrumentations patch those modules at
 * require time, and an earlier import would leave them untraced.
 */
import { config } from "./config.js";
import { flushTraces, shutdownTracing } from "./tracing.js";

import { buildApp } from "./app.js";
import { closeGrpcClient, waitForSidecar } from "./grpc-client.js";

const SIDECAR_WAIT_MS = Number(process.env.SIDECAR_WAIT_MS ?? 30_000);

async function main(): Promise<void> {
  const app = await buildApp();

  // Best-effort warm-up: surface an unreachable sidecar in the logs at start,
  // but still bind the port so /healthz and /readyz can report the problem.
  try {
    await waitForSidecar(SIDECAR_WAIT_MS);
    app.log.info({ target: config.sidecarTarget }, "sidecar channel ready");
  } catch (err) {
    app.log.warn(
      { err, target: config.sidecarTarget },
      "sidecar not ready at startup; will connect on first request",
    );
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      otlp_traces_endpoint: config.otlpTracesUrl,
      jaeger_query_url: config.jaegerQueryUrl,
      sidecar_target: config.sidecarTarget,
    },
    "prediction gateway listening",
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");

    // Order matters: stop accepting work, release the channel, then flush the
    // spans produced by the requests we just finished.
    try {
      await app.close();
      closeGrpcClient();
      await flushTraces();
      await shutdownTracing();
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? 0);
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((err) => {
  console.error("fatal: failed to start prediction gateway", err);
  process.exit(1);
});
