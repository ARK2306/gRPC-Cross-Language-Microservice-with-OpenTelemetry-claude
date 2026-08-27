/** Fastify application factory. Kept separate from server.ts so tests can build an app without binding a port. */
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

import { config } from "./config.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPredictRoute } from "./routes/predict.js";
import { registerStreamRoute } from "./routes/stream.js";
import { registerTraceTestRoute } from "./routes/trace-test.js";
import { traceContextPlugin } from "./trace-context.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Correlate log lines with Jaeger without logging the whole span context.
      redact: { paths: ["req.headers.authorization", "req.headers.cookie"], remove: true },
    },
    // SSE responses are written to reply.raw and can outlive the default
    // keep-alive window on slow streams.
    keepAliveTimeout: 72_000,
    requestTimeout: 0,
    trustProxy: true,
    ajv: {
      customOptions: {
        // Fastify defaults to removeAdditional:true, which silently drops
        // properties the schema does not declare. For an inference API that
        // turns a typo like {"inputs":[...]} into a confusing 400 about a
        // missing `input`; failing loudly on the unknown key is kinder.
        removeAdditional: false,
        allErrors: true,
      },
    },
  });

  // `curl -d '{"input":[1,2,3]}'` sends application/x-www-form-urlencoded, not
  // JSON, which Fastify would otherwise reject with 415. The documented
  // one-liner in the README is worth supporting, so a form-urlencoded body that
  // is actually JSON is accepted; anything else still fails as a 400.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body: string, done) => {
      try {
        done(null, JSON.parse(body));
      } catch {
        done(
          Object.assign(new Error("body must be valid JSON"), {
            statusCode: 400,
            code: "FST_ERR_CTP_INVALID_JSON_BODY",
          }),
          undefined,
        );
      }
    },
  );

  await app.register(traceContextPlugin);

  await registerHealthRoutes(app);
  await registerPredictRoute(app);
  await registerStreamRoute(app);
  await registerTraceTestRoute(app);

  app.get("/", async () => ({
    service: config.serviceName,
    version: config.serviceVersion,
    endpoints: {
      "POST /predict": "unary gRPC inference; body {\"input\":[1,2,3]}",
      "GET /stream": "server-streaming gRPC as SSE; ?input=1,2,3&steps=5",
      "GET /trace-test": "verify a trace reaches Jaeger end to end",
      "GET /healthz": "liveness",
      "GET /readyz": "readiness",
    },
  }));

  app.setNotFoundHandler(async (request, reply) =>
    reply.status(404).send({ error: "NOT_FOUND", message: `no route for ${request.method} ${request.url}` }),
  );

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    // Schema violations are the caller's problem; report them as 400.
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, "unhandled error");
    return reply.status(status).send({
      error: error.code ?? "INTERNAL_ERROR",
      message: status >= 500 ? "internal server error" : error.message,
      trace_id: request.traceId,
    });
  });

  return app;
}
