/** POST /predict — JSON in, unary gRPC to the sidecar, JSON out. */
import * as grpc from "@grpc/grpc-js";
import type { FastifyInstance } from "fastify";

import { GrpcCallError, predict } from "../grpc-client.js";
import { predictBodySchema, type PredictBody } from "./schemas.js";

/** Map sidecar gRPC statuses onto HTTP statuses the caller can act on. */
export function httpStatusForGrpc(code: grpc.status): number {
  switch (code) {
    case grpc.status.INVALID_ARGUMENT:
      return 400;
    case grpc.status.NOT_FOUND:
      return 404;
    case grpc.status.DEADLINE_EXCEEDED:
      return 504;
    case grpc.status.UNAVAILABLE:
      return 503;
    case grpc.status.RESOURCE_EXHAUSTED:
      return 429;
    case grpc.status.UNIMPLEMENTED:
      return 501;
    default:
      return 502;
  }
}

export async function registerPredictRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Body: PredictBody }>(
    "/predict",
    { schema: { body: predictBodySchema } },
    async (request, reply) => {
      const { input, model, request_id } = request.body;

      try {
        const response = await predict({
          input,
          model: model ?? "",
          request_id: request_id ?? request.id,
        });

        // Annotate the active server span so cache behaviour is visible in Jaeger
        // without having to open the sidecar's spans.
        request.otelSpan?.setAttributes({
          "prediction.model": response.model,
          "prediction.cached": response.cached,
          "prediction.compute_ms": response.compute_ms,
          "prediction.input_size": input.length,
        });

        return reply.send({
          output: response.output,
          score: response.score,
          model: response.model,
          cached: response.cached,
          cache_key: response.cache_key,
          compute_ms: response.compute_ms,
          request_id: response.request_id,
          trace_id: request.traceId,
        });
      } catch (err) {
        if (err instanceof GrpcCallError) {
          const status = httpStatusForGrpc(err.code);
          request.log.warn({ err, grpcCode: grpc.status[err.code] }, "Predict RPC failed");
          return reply.status(status).send({
            error: grpc.status[err.code] ?? "UNKNOWN",
            message: err.details || err.message,
            trace_id: request.traceId,
          });
        }
        throw err;
      }
    },
  );
}
