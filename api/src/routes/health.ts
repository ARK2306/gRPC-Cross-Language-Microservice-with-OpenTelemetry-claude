/** Liveness and readiness probes. Excluded from tracing (see tracing.ts). */
import type { FastifyInstance } from "fastify";

import { config } from "../config.js";
import { channelState } from "../grpc-client.js";
import { jaegerReachable } from "../jaeger.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness: the process is up. Never depends on other services, so a sidecar
  // outage doesn't get the container restarted.
  app.get("/healthz", async () => ({
    status: "ok",
    service: config.serviceName,
    version: config.serviceVersion,
    uptime_s: Math.round(process.uptime()),
  }));

  // Readiness: safe to route traffic here.
  app.get("/readyz", async (_request, reply) => {
    const grpcState = channelState();
    const ready = grpcState === "READY" || grpcState === "IDLE";
    return reply.status(ready ? 200 : 503).send({
      status: ready ? "ready" : "not-ready",
      dependencies: {
        sidecar: { target: config.sidecarTarget, channel_state: grpcState },
        // Reported but not gating: traces are best-effort, and a Jaeger outage
        // must not take the gateway out of rotation.
        jaeger: { query_url: config.jaegerQueryUrl, reachable: await jaegerReachable() },
      },
    });
  });
}
